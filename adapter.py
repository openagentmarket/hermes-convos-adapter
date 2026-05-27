from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shlex
from pathlib import Path
from typing import Any, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import build_session_key

logger = logging.getLogger(__name__)


PLUGIN_DIR = Path(__file__).resolve().parent
SIDECAR_DIR = PLUGIN_DIR / "sidecar"


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _sidecar_command() -> list[str]:
    override = _env("CONVOS_SIDECAR_COMMAND")
    if override:
        return shlex.split(override)

    dist = SIDECAR_DIR / "dist" / "index.js"
    if dist.exists():
        return ["node", str(dist)]

    return ["npm", "--silent", "--prefix", str(SIDECAR_DIR), "run", "start"]


def check_requirements() -> bool:
    if not _env("CONVOS_XMTP_WALLET_KEY"):
        return False
    return SIDECAR_DIR.exists()


def validate_config(config: PlatformConfig) -> tuple[bool, str]:
    if not _env("CONVOS_XMTP_WALLET_KEY"):
        return False, "CONVOS_XMTP_WALLET_KEY is required"
    return True, ""


def is_connected(config: PlatformConfig) -> bool:
    return bool(_env("CONVOS_XMTP_WALLET_KEY"))


def _env_enablement() -> Optional[dict]:
    if not _env("CONVOS_XMTP_WALLET_KEY"):
        return None

    extra: Dict[str, Any] = {
        "xmtp_env": _env("CONVOS_XMTP_ENV", "production"),
        "agent_name": _env("CONVOS_AGENT_NAME", "Hermes"),
        "group_name": _env("CONVOS_GROUP_NAME", _env("CONVOS_AGENT_NAME", "Hermes")),
    }
    if _env("CONVOS_DATA_DIR"):
        extra["data_dir"] = _env("CONVOS_DATA_DIR")
    if _env("CONVOS_HOME_CHANNEL"):
        extra["home_channel"] = _env("CONVOS_HOME_CHANNEL")

    result: Dict[str, Any] = {"enabled": True, "extra": extra}
    home_channel = _env("CONVOS_HOME_CHANNEL")
    if home_channel:
        result["home_channel"] = {
            "chat_id": home_channel,
            "name": _env("CONVOS_HOME_CHANNEL_NAME", home_channel),
        }
    return result


class ConvosAdapter(BasePlatformAdapter):
    """Hermes platform adapter for Convos/XMTP.

    The XMTP SDK used by OpenAgent is Node-based today, so this adapter owns a
    Node child process and talks to it over newline-delimited JSON. Hermes still
    sees Convos as a normal platform adapter: inbound messages become
    MessageEvent objects, and outbound sends go through BasePlatformAdapter.
    """

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("convos"))
        extra = getattr(config, "extra", {}) or {}
        self.agent_name = _env("CONVOS_AGENT_NAME", str(extra.get("agent_name") or "Hermes"))
        self.group_name = _env("CONVOS_GROUP_NAME", str(extra.get("group_name") or self.agent_name))
        self.xmtp_env = _env("CONVOS_XMTP_ENV", str(extra.get("xmtp_env") or "production"))
        self.data_dir = _env(
            "CONVOS_DATA_DIR",
            str(extra.get("data_dir") or (Path(os.getenv("HERMES_HOME", "~/.hermes")).expanduser() / "convos")),
        )
        self.max_message_length = int(extra.get("max_message_length") or 3500)

        self._process: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._ready = asyncio.Event()
        self._home_channel: Optional[str] = _env("CONVOS_HOME_CHANNEL") or extra.get("home_channel")

    @property
    def name(self) -> str:
        return "Convos"

    async def connect(self) -> bool:
        if self._process and self._process.returncode is None:
            return True

        env = os.environ.copy()
        env.update({
            "CONVOS_AGENT_NAME": self.agent_name,
            "CONVOS_GROUP_NAME": self.group_name,
            "CONVOS_XMTP_ENV": self.xmtp_env,
            "CONVOS_DATA_DIR": self.data_dir,
            "CONVOS_INFO_FILE": _env("CONVOS_INFO_FILE", str(Path(self.data_dir) / "info.json")),
        })

        command = _sidecar_command()
        logger.info("Convos: starting sidecar: %s", " ".join(shlex.quote(part) for part in command))

        self._process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(PLUGIN_DIR),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._stdout_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

        try:
            await asyncio.wait_for(self._ready.wait(), timeout=45)
        except asyncio.TimeoutError:
            logger.error("Convos: sidecar did not become ready")
            await self.disconnect()
            return False
        return True

    async def disconnect(self) -> None:
        for task in (self._stdout_task, self._stderr_task):
            if task:
                task.cancel()
        self._stdout_task = None
        self._stderr_task = None

        if self._process and self._process.returncode is None:
            try:
                await self._request("disconnect", {}, timeout=2)
            except Exception:
                pass
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        self._process = None
        self._ready.clear()

        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError("Convos sidecar disconnected"))
        self._pending.clear()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        try:
            result = await self._request(
                "send",
                {
                    "chatId": chat_id,
                    "content": content,
                    "replyTo": reply_to,
                    "metadata": metadata or {},
                },
                timeout=60,
            )
            return SendResult(
                success=True,
                message_id=str(result.get("messageId") or ""),
                raw_response=result,
            )
        except Exception as exc:
            logger.warning("Convos send failed: %s", exc)
            return SendResult(success=False, error=str(exc), retryable=True)

    async def send_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        # XMTP/Convos typing support is not exposed through the sidecar yet.
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {
            "name": chat_id,
            "type": "group",
            "chat_id": chat_id,
        }

    async def _request(self, action: str, payload: Dict[str, Any], timeout: float = 30) -> Dict[str, Any]:
        if not self._process or not self._process.stdin or self._process.returncode is not None:
            raise RuntimeError("Convos sidecar is not running")

        request_id = secrets.token_hex(8)
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[request_id] = future
        message = {"id": request_id, "action": action, **payload}
        self._process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        await self._process.stdin.drain()
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)

    async def _read_stdout(self) -> None:
        assert self._process and self._process.stdout
        while True:
            line = await self._process.stdout.readline()
            if not line:
                break
            try:
                event = json.loads(line.decode("utf-8"))
            except Exception:
                logger.debug("Convos sidecar non-JSON stdout: %r", line[:200])
                continue
            await self._handle_sidecar_event(event)

    async def _read_stderr(self) -> None:
        assert self._process and self._process.stderr
        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            logger.info("Convos sidecar: %s", line.decode("utf-8", errors="replace").rstrip())

    async def _handle_sidecar_event(self, event: Dict[str, Any]) -> None:
        event_type = event.get("type")
        request_id = event.get("id")

        if request_id and request_id in self._pending:
            future = self._pending[request_id]
            if future.done():
                return
            if event_type == "error":
                future.set_exception(RuntimeError(str(event.get("error") or "sidecar error")))
            else:
                future.set_result(event)
            return

        if event_type == "ready":
            self._home_channel = event.get("conversationId") or self._home_channel
            if self._home_channel and not os.getenv("CONVOS_HOME_CHANNEL"):
                os.environ["CONVOS_HOME_CHANNEL"] = self._home_channel
            invite_url = event.get("inviteUrl")
            if invite_url:
                logger.info("Convos invite URL: %s", invite_url)
            self._ready.set()
            return

        if event_type == "message":
            text = str(event.get("text") or "").strip()
            if not text:
                return
            chat_id = str(event.get("chatId") or "")
            user_id = str(event.get("userId") or "")
            source = self.build_source(
                chat_id=chat_id,
                chat_name=str(event.get("chatName") or chat_id),
                chat_type=str(event.get("chatType") or "group"),
                user_id=user_id,
                user_name=str(event.get("userName") or user_id),
                message_id=str(event.get("messageId") or ""),
            )
            message = MessageEvent(
                text=text,
                message_type=MessageType.COMMAND if text.startswith("/") else MessageType.TEXT,
                source=source,
                raw_message=event,
                message_id=str(event.get("messageId") or ""),
            )
            if await self._maybe_handle_approval_command(message):
                return
            await self.handle_message(message)
            return

        if event_type == "log":
            logger.info("Convos sidecar: %s", event.get("message") or "")

    async def _maybe_handle_approval_command(self, message: MessageEvent) -> bool:
        """Resolve gateway approvals without creating a new chat turn.

        Hermes keeps dangerous-command approvals in an in-process queue keyed by
        the same session key that BasePlatformAdapter uses.  Platform adapters
        such as Telegram/Discord route /approve and /deny directly to that
        queue while an agent thread is blocked.  Convos needs the same fast path
        because every XMTP inbound payload is otherwise just another message.

        Return True only when a live approval was consumed.  If nothing is
        pending, fall back to Hermes' normal slash command router so users still
        get the standard "no pending approval" response.
        """
        if not message.text.startswith("/"):
            return False

        command = message.get_command()
        if command not in {"approve", "deny", "always", "cancel"}:
            return False

        source = message.source
        if source is None:
            return False

        session_key = build_session_key(
            source,
            group_sessions_per_user=self.config.extra.get("group_sessions_per_user", True),
            thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
        )

        try:
            from tools.approval import has_blocking_approval, resolve_gateway_approval
        except Exception as exc:
            logger.warning("Convos approval fast path unavailable: %s", exc)
            return False

        try:
            if not has_blocking_approval(session_key):
                logger.info(
                    "Convos approval command /%s for %s had no pending approval",
                    command,
                    session_key,
                )
                return False

            args = (message.get_command_args() or "").strip().lower().split()
            resolve_all = "all" in args
            remaining = [arg for arg in args if arg != "all"]

            if command == "deny" or command == "cancel":
                choice = "deny"
            elif command == "always" or any(arg in {"always", "permanent", "permanently"} for arg in remaining):
                choice = "always"
            elif any(arg in {"session", "ses"} for arg in remaining):
                choice = "session"
            else:
                choice = "once"

            count = resolve_gateway_approval(session_key, choice, resolve_all=resolve_all)
            if count <= 0:
                return False

            logger.info(
                "Convos consumed /%s for %s: resolved %d approval(s) as %s",
                command,
                session_key,
                count,
                choice,
            )

            if choice == "deny":
                text = f"Denied {count} pending command{'s' if count != 1 else ''}."
            elif choice == "always":
                text = f"Approved permanently ({count} command{'s' if count != 1 else ''})."
            elif choice == "session":
                text = f"Approved for this session ({count} command{'s' if count != 1 else ''})."
            else:
                text = f"Approved {count} pending command{'s' if count != 1 else ''}."

            await self.send(source.chat_id, text, reply_to=message.message_id)
            return True
        except Exception as exc:
            logger.error("Convos approval fast path failed: %s", exc, exc_info=True)
            return False


def interactive_setup() -> None:
    print("Run ./install.sh from the hermes-convos-adapter repo to install and bootstrap Convos.")
    print("The installer generates CONVOS_XMTP_WALLET_KEY if it is missing.")
    print("For private agents, set CONVOS_ALLOWED_USERS to owner XMTP inbox IDs.")


def register(ctx) -> None:
    ctx.register_platform(
        name="convos",
        label="Convos",
        adapter_factory=lambda cfg: ConvosAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["CONVOS_XMTP_WALLET_KEY"],
        install_hint="Run `npm install && npm run build` inside hermes-convos-adapter/sidecar.",
        setup_fn=interactive_setup,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="CONVOS_HOME_CHANNEL",
        allowed_users_env="CONVOS_ALLOWED_USERS",
        allow_all_env="CONVOS_ALLOW_ALL_USERS",
        max_message_length=3500,
        emoji="💬",
        pii_safe=False,
        allow_update_command=True,
    )
