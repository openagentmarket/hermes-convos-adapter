import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { startAgent } from 'convos-node-sdk';
import type { AgentRuntime, MessageContext } from 'convos-node-sdk';

const XMTP_ENV = (process.env.CONVOS_XMTP_ENV || process.env.XMTP_ENV || 'production') as 'production' | 'dev' | 'local';
const DATA_DIR = process.env.CONVOS_DATA_DIR || path.join(process.env.HERMES_HOME || '.hermes', 'convos');
const GROUP_STATE_FILE = path.join(DATA_DIR, 'group.json');
const GROUPS_STATE_FILE = path.join(DATA_DIR, 'groups.json');
const INFO_FILE = process.env.CONVOS_INFO_FILE || path.join(DATA_DIR, 'info.json');
const AGENT_NAME = (process.env.CONVOS_AGENT_NAME || process.env.AGENT_NAME || 'Hermes').trim() || 'Hermes';
const GROUP_NAME = (process.env.CONVOS_GROUP_NAME || AGENT_NAME).trim() || AGENT_NAME;
const CONTROL_HOST = process.env.CONVOS_CONTROL_HOST || '127.0.0.1';
const CONTROL_PORT = Number.parseInt(process.env.CONVOS_CONTROL_PORT || '8787', 10);
const CONVERSATION_POOL_SIZE = Math.max(0, Number.parseInt(process.env.CONVOS_CONVERSATION_POOL_SIZE || '1', 10) || 0);

type GroupState = {
  conversationId: string;
  inviteUrl: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
  status?: 'active' | 'pooled';
  createdAt?: string;
  updatedAt?: string;
};

type GroupsState = {
  defaultConversationId?: string;
  conversations: GroupState[];
};

type SidecarRequest = {
  id?: string;
  action?: string;
  chatId?: string;
  content?: string;
};

const SEND_ACK_TIMEOUT_MS = Number.parseInt(process.env.CONVOS_SEND_ACK_TIMEOUT_MS || '12000', 10);

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function loadGroupState(): GroupState | null {
  try {
    return JSON.parse(fs.readFileSync(GROUP_STATE_FILE, 'utf8')) as GroupState;
  } catch {
    return null;
  }
}

function loadGroupsState(): GroupsState {
  try {
    const parsed = JSON.parse(fs.readFileSync(GROUPS_STATE_FILE, 'utf8')) as Partial<GroupsState>;
    const conversations = Array.isArray(parsed.conversations) ? parsed.conversations.filter((item) => {
      return item && typeof item.conversationId === 'string' && typeof item.inviteUrl === 'string';
    }) : [];
    return {
      defaultConversationId: typeof parsed.defaultConversationId === 'string' ? parsed.defaultConversationId : conversations[0]?.conversationId,
      conversations,
    };
  } catch {
    const legacy = loadGroupState();
    if (!legacy) return { conversations: [] };
    const now = new Date().toISOString();
    return {
      defaultConversationId: legacy.conversationId,
      conversations: [{
        ...legacy,
        name: legacy.name || GROUP_NAME,
        isDefault: true,
        createdAt: legacy.createdAt || now,
        updatedAt: legacy.updatedAt || now,
      }],
    };
  }
}

function saveGroupsState(state: GroupsState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GROUPS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  const defaultGroup = state.conversations.find((group) => group.conversationId === state.defaultConversationId) || state.conversations[0];
  if (defaultGroup) {
    fs.writeFileSync(GROUP_STATE_FILE, JSON.stringify(defaultGroup, null, 2), 'utf8');
  }
}

function writeInfoFile(info: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(INFO_FILE), { recursive: true });
  fs.writeFileSync(INFO_FILE, JSON.stringify(info, null, 2), 'utf8');
}

function publicGroup(group: GroupState): Record<string, unknown> {
  return {
    conversationId: group.conversationId,
    inviteUrl: group.inviteUrl,
    name: group.name || null,
    description: group.description || null,
    isDefault: Boolean(group.isDefault),
    status: group.status || 'active',
    createdAt: group.createdAt || null,
    updatedAt: group.updatedAt || null,
  };
}

function writeJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof (content as any).content === 'string') {
    return (content as any).content;
  }
  try {
    return JSON.stringify(content, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  } catch {
    return String(content);
  }
}

function messageId(ctx: MessageContext): string {
  const raw = ctx as any;
  return String(raw.messageId || raw.id || raw.contentTopic || `${Date.now()}`);
}

async function sendWithOptimisticAck(runtime: AgentRuntime, chatId: string, content: string): Promise<{
  messageId: string;
  optimistic: boolean;
}> {
  const messageId = `convos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let settled = false;
  const sendPromise = runtime.sendToConversation(chatId, content)
    .then(() => {
      settled = true;
      log(`[convos] send resolved chat=${chatId} message=${messageId}`);
    })
    .catch((err) => {
      settled = true;
      log(`[convos] send failed chat=${chatId} message=${messageId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), SEND_ACK_TIMEOUT_MS);
  });

  const result = await Promise.race([sendPromise.then(() => 'sent' as const), timeoutPromise]);
  if (result === 'timeout' && !settled) {
    log(`[convos] send ack timeout after ${SEND_ACK_TIMEOUT_MS}ms; treating as accepted chat=${chatId} message=${messageId}`);
    sendPromise.catch(() => undefined);
    return { messageId, optimistic: true };
  }

  return { messageId, optimistic: false };
}

async function main(): Promise<void> {
  if (!process.env.XMTP_WALLET_KEY && process.env.CONVOS_XMTP_WALLET_KEY) {
    process.env.XMTP_WALLET_KEY = process.env.CONVOS_XMTP_WALLET_KEY;
  }
  if (!process.env.XMTP_DB_ENCRYPTION_KEY && process.env.CONVOS_XMTP_DB_ENCRYPTION_KEY) {
    process.env.XMTP_DB_ENCRYPTION_KEY = process.env.CONVOS_XMTP_DB_ENCRYPTION_KEY;
  }
  if (!process.env.XMTP_WALLET_KEY) {
    throw new Error('CONVOS_XMTP_WALLET_KEY or XMTP_WALLET_KEY is required');
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  let groupsState = loadGroupsState();
  let runtime: AgentRuntime;
  let runtimeAddress = '';
  let runtimeInboxId = '';
  let poolCreation: Promise<void> | null = null;

  function activeConversations(): GroupState[] {
    return groupsState.conversations.filter((group) => group.status !== 'pooled');
  }

  function pooledConversations(): GroupState[] {
    return groupsState.conversations.filter((group) => group.status === 'pooled');
  }

  async function createConversation(options: {
    name?: string;
    description?: string;
    isDefault?: boolean;
    status?: 'active' | 'pooled';
  }): Promise<GroupState> {
    const now = new Date().toISOString();
    const groupName = (options.name || GROUP_NAME).trim().slice(0, 120) || GROUP_NAME;
    const description = options.description?.trim().slice(0, 500);
    const group = await runtime.createGroup({ name: groupName, description });
    const status = options.status || 'active';
    const state: GroupState = {
      conversationId: group.conversationId,
      inviteUrl: group.inviteUrl,
      name: groupName,
      description,
      isDefault: Boolean(options.isDefault),
      status,
      createdAt: now,
      updatedAt: now,
    };
    if (state.isDefault) {
      groupsState.conversations = groupsState.conversations.map((item) => ({ ...item, isDefault: false }));
      groupsState.defaultConversationId = state.conversationId;
    }
    groupsState.conversations.push(state);
    if (!groupsState.defaultConversationId) {
      groupsState.defaultConversationId = state.conversationId;
      state.isDefault = true;
      state.status = 'active';
    }
    saveGroupsState(groupsState);
    return state;
  }

  async function fillConversationPool(): Promise<void> {
    if (CONVERSATION_POOL_SIZE <= 0) return;

    while (pooledConversations().length < CONVERSATION_POOL_SIZE) {
      const group = await createConversation({
        name: GROUP_NAME,
        status: 'pooled',
      });
      log(`[convos] pooled conversation ${group.conversationId}`);
      refreshInfo();
    }
  }

  function ensureConversationPool(): void {
    if (CONVERSATION_POOL_SIZE <= 0 || poolCreation) return;
    poolCreation = fillConversationPool()
      .catch((err) => {
        log(`[convos] conversation pool fill failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        poolCreation = null;
      });
  }

  function claimPooledConversation(options: { name?: string; description?: string }): GroupState | null {
    const group = pooledConversations()[0];
    if (!group) return null;

    const now = new Date().toISOString();
    group.name = (options.name || GROUP_NAME).trim().slice(0, 120) || GROUP_NAME;
    const description = options.description?.trim().slice(0, 500);
    group.description = description || undefined;
    group.status = 'active';
    group.isDefault = false;
    group.updatedAt = now;
    saveGroupsState(groupsState);
    return group;
  }

  function refreshInfo(): void {
    const defaultGroup = activeConversations().find((group) => group.conversationId === groupsState.defaultConversationId) || activeConversations()[0];
    writeInfoFile({
      status: 'running',
      runtime: 'hermes',
      botId: process.env.BOT_ID || 'hermes',
      address: runtimeAddress || runtime.address,
      inboxId: runtimeInboxId || runtime.inboxId,
      inviteUrl: defaultGroup?.inviteUrl || '',
      agentName: AGENT_NAME,
      conversationId: defaultGroup?.conversationId || '',
      conversations: activeConversations().map(publicGroup),
      conversationPoolSize: pooledConversations().length,
      updatedAt: new Date().toISOString(),
    });
  }

  runtime = await startAgent({
    dataDir: DATA_DIR,
    env: XMTP_ENV,

    onInvite: async (ctx) => {
      log(`[convos] accepting invite for ${ctx.conversationId}`);
      await ctx.accept();
    },

    onMessage: async (ctx: MessageContext) => {
      const text = extractText(ctx.content).trim();
      if (!text) return;
      emit({
        type: 'message',
        chatId: ctx.conversationId,
        chatName: GROUP_NAME,
        chatType: 'group',
        userId: ctx.senderInboxId,
        userName: ctx.senderInboxId,
        messageId: messageId(ctx),
        text,
      });
    },

    onStart: (info) => {
      runtimeAddress = info.address;
      runtimeInboxId = info.inboxId;
      log(`[convos] online address=${info.address} inboxId=${info.inboxId}`);
    },

    onError: (err) => {
      log(`[convos] ${err.message}`);
    },
  });

  if (activeConversations().length > 0) {
    log(`[convos] reusing ${activeConversations().length} active group(s), ${pooledConversations().length} pooled group(s)`);
    saveGroupsState(groupsState);
  } else {
    const group = await createConversation({ name: GROUP_NAME, isDefault: true });
    log(`[convos] created default group ${group.conversationId}`);
  }

  const groupState = activeConversations().find((group) => group.conversationId === groupsState.defaultConversationId) || activeConversations()[0];
  emit({
    type: 'ready',
    conversationId: groupState.conversationId,
    inviteUrl: groupState.inviteUrl,
    address: runtimeAddress || runtime.address,
    inboxId: runtimeInboxId || runtime.inboxId,
    agentName: AGENT_NAME,
  });
  refreshInfo();
  ensureConversationPool();

  const controlServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${CONTROL_HOST}:${CONTROL_PORT}`);
    try {
      if (req.method === 'GET' && url.pathname === '/conversations') {
        writeJson(res, 200, {
          conversations: activeConversations().map(publicGroup),
          defaultConversationId: groupsState.defaultConversationId || null,
          poolSize: pooledConversations().length,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/conversations') {
        const body = await readJsonBody(req);
        const options = {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
        };
        const pooled = claimPooledConversation(options);
        const group = pooled || await createConversation({
          ...options,
          isDefault: false,
        });
        refreshInfo();
        ensureConversationPool();
        writeJson(res, 201, { conversation: publicGroup(group) });
        return;
      }

      writeJson(res, 404, { error: 'not_found' });
    } catch (err) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    log(`[convos] control server listening on ${CONTROL_HOST}:${CONTROL_PORT}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    let req: SidecarRequest;
    try {
      req = JSON.parse(line) as SidecarRequest;
    } catch {
      emit({ type: 'error', error: 'invalid json request' });
      return;
    }

    try {
      if (req.action === 'send') {
        const chatId = String(req.chatId || '');
        const content = String(req.content || '');
        if (!chatId || !content) throw new Error('send requires chatId and content');
        const result = await sendWithOptimisticAck(runtime, chatId, content);
        emit({ type: 'sent', id: req.id, messageId: result.messageId, optimistic: result.optimistic });
        return;
      }

      if (req.action === 'disconnect') {
        emit({ type: 'disconnected', id: req.id });
        controlServer.close();
        process.exit(0);
      }

      throw new Error(`unknown action: ${req.action || ''}`);
    } catch (err) {
      emit({
        type: 'error',
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

main().catch((err) => {
  log(`[fatal] ${err instanceof Error ? err.stack || err.message : String(err)}`);
  emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
