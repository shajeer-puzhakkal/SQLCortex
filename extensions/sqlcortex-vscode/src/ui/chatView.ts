import * as vscode from "vscode";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

type ChatSession = {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
};

type WebviewState = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

type WebviewMessage =
  | { type: "ready" }
  | { type: "createSession" }
  | { type: "selectSession"; sessionId: string }
  | { type: "sendMessage"; text: string }
  | { type: "renameSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string };

const STORAGE_KEY = "sqlcortex.chat.sessions";
const ACTIVE_KEY = "sqlcortex.chat.activeSessionId";
const MAX_SESSIONS = 50;
const MAX_MESSAGES = 200;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private sessions: ChatSession[] = [];
  private activeSessionId: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(
      (message) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables
    );

    this.loadState();
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as WebviewMessage | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }

    switch (payload.type) {
      case "ready":
        this.loadState();
        this.postState();
        return;
      case "createSession":
        this.createSession();
        await this.saveState();
        this.postState();
        return;
      case "selectSession":
        this.activeSessionId = payload.sessionId;
        await this.saveState();
        this.postState();
        return;
      case "sendMessage":
        await this.addMessage(payload.text);
        this.postState();
        return;
      case "renameSession":
        await this.renameSession(payload.sessionId);
        this.postState();
        return;
      case "deleteSession":
        await this.deleteSession(payload.sessionId);
        this.postState();
        return;
      default:
        return;
    }
  }

  private createSession(): ChatSession {
    const session: ChatSession = {
      id: this.generateId(),
      title: "New chat",
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.trimSessions();
    return session;
  }

  private async addMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    let session = this.getActiveSession();
    if (!session) {
      session = this.createSession();
    }

    session.messages.push({
      id: this.generateId(),
      role: "user",
      text: trimmed,
      timestamp: new Date().toISOString(),
    });

    if (session.title === "New chat") {
      session.title = trimmed.length > 36 ? `${trimmed.slice(0, 36)}...` : trimmed;
    }

    session.updatedAt = new Date().toISOString();
    this.trimMessages(session);
    this.sortSessions();
    await this.saveState();
  }

  private async renameSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }
    const updated = await vscode.window.showInputBox({
      prompt: "Rename chat session",
      value: session.title,
      ignoreFocusOut: true,
    });
    if (!updated) {
      return;
    }
    session.title = updated.trim() || session.title;
    session.updatedAt = new Date().toISOString();
    this.sortSessions();
    await this.saveState();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex((item) => item.id === sessionId);
    if (index === -1) {
      return;
    }
    this.sessions.splice(index, 1);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
    }
    await this.saveState();
  }

  private getActiveSession(): ChatSession | undefined {
    if (!this.activeSessionId) {
      return undefined;
    }
    return this.sessions.find((session) => session.id === this.activeSessionId);
  }

  private loadState(): void {
    const storedSessions = this.context.globalState.get<ChatSession[]>(STORAGE_KEY, []);
    this.sessions = Array.isArray(storedSessions) ? storedSessions : [];
    const storedActive = this.context.globalState.get<string | null>(ACTIVE_KEY, null);
    this.activeSessionId = storedActive ?? null;

    if (this.sessions.length > 0 && !this.activeSessionId) {
      this.activeSessionId = this.sessions[0].id;
    }

    this.sortSessions();
    this.trimSessions();
  }

  private async saveState(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, this.sessions);
    await this.context.globalState.update(ACTIVE_KEY, this.activeSessionId);
  }

  private trimSessions(): void {
    if (this.sessions.length <= MAX_SESSIONS) {
      return;
    }
    this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    const sessionIds = new Set(this.sessions.map((session) => session.id));
    if (this.activeSessionId && !sessionIds.has(this.activeSessionId)) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
    }
  }

  private trimMessages(session: ChatSession): void {
    if (session.messages.length <= MAX_MESSAGES) {
      return;
    }
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }

  private sortSessions(): void {
    this.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const state: WebviewState = {
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    };
    void this.view.webview.postMessage({ type: "state", state });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SQLCortex Chat</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      body {
        margin: 0;
        padding: 16px 16px 12px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
      }

      .shell {
        display: flex;
        flex-direction: column;
        gap: 12px;
        height: calc(100vh - 28px);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .header h1 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--vscode-sideBarTitle-foreground);
      }

      .header button {
        border: none;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .section-title {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        margin: 0;
      }

      .sessions {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border-bottom: 1px solid var(--vscode-panel-border);
        padding-bottom: 10px;
      }

      .session-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px;
        border-radius: 6px;
        background: transparent;
        border: 1px solid transparent;
        cursor: pointer;
      }

      .session-item.active {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .session-title {
        font-size: 12px;
        font-weight: 600;
      }

      .session-meta {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }

      .session-item.active .session-meta {
        color: inherit;
      }

      .session-actions {
        display: flex;
        gap: 6px;
      }

      .session-actions button {
        border: none;
        background: transparent;
        color: var(--vscode-textLink-foreground);
        font-size: 11px;
        cursor: pointer;
        padding: 0;
      }

      .session-actions button:hover {
        text-decoration: underline;
      }

      .chat {
        display: flex;
        flex-direction: column;
        gap: 12px;
        flex: 1;
        min-height: 0;
      }

      .messages {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-right: 2px;
      }

      .message {
        padding: 10px 12px;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.5;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .message.user {
        align-self: flex-end;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: transparent;
      }

      .placeholder {
        padding: 12px;
        border-radius: 8px;
        border: 1px dashed var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
        font-size: 12px;
      }

      .composer {
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }

      textarea {
        flex: 1;
        min-height: 44px;
        max-height: 120px;
        resize: vertical;
        border-radius: 6px;
        border: 1px solid var(--vscode-input-border);
        padding: 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-family: var(--vscode-font-family);
        font-size: 12px;
      }

      .send {
        border: none;
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .toggle {
        border: none;
        background: transparent;
        color: var(--vscode-textLink-foreground);
        font-size: 11px;
        cursor: pointer;
        padding: 0;
        align-self: flex-start;
      }

      .toggle:hover {
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="header">
        <h1>Chat</h1>
        <button id="newSession">New</button>
      </div>

      <div class="sessions">
        <p class="section-title">Recent sessions</p>
        <div id="sessionList"></div>
        <button id="toggleSessions" class="toggle"></button>
      </div>

      <div class="chat">
        <div id="messages" class="messages"></div>
        <div class="composer">
          <textarea id="input" placeholder="Describe what to build next"></textarea>
          <button id="send" class="send">Send</button>
        </div>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const sessionList = document.getElementById("sessionList");
      const toggleSessions = document.getElementById("toggleSessions");
      const messagesEl = document.getElementById("messages");
      const input = document.getElementById("input");
      const sendButton = document.getElementById("send");
      const newSessionButton = document.getElementById("newSession");

      let state = { sessions: [], activeSessionId: null };
      let showAllSessions = true;
      const maxVisibleSessions = 5;

      function renderSessions() {
        sessionList.innerHTML = "";
        if (!state.sessions.length) {
          const empty = document.createElement("div");
          empty.className = "placeholder";
          empty.textContent = "No chat sessions yet.";
          sessionList.appendChild(empty);
          toggleSessions.textContent = "";
          return;
        }
        const sessions = showAllSessions
          ? state.sessions
          : state.sessions.slice(0, maxVisibleSessions);
        sessions.forEach((session) => {
          const item = document.createElement("div");
          item.className = "session-item";
          if (session.id === state.activeSessionId) {
            item.classList.add("active");
          }
          const title = document.createElement("div");
          title.className = "session-title";
          title.textContent = session.title || "Untitled";
          const meta = document.createElement("div");
          meta.className = "session-meta";
          meta.textContent = formatDate(session.updatedAt);
          const actions = document.createElement("div");
          actions.className = "session-actions";
          const renameButton = document.createElement("button");
          renameButton.textContent = "Rename";
          renameButton.addEventListener("click", (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: "renameSession", sessionId: session.id });
          });
          const deleteButton = document.createElement("button");
          deleteButton.textContent = "Delete";
          deleteButton.addEventListener("click", (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: "deleteSession", sessionId: session.id });
          });
          actions.appendChild(renameButton);
          actions.appendChild(deleteButton);
          item.appendChild(title);
          item.appendChild(meta);
          item.appendChild(actions);
          item.addEventListener("click", () => {
            vscode.postMessage({ type: "selectSession", sessionId: session.id });
          });
          sessionList.appendChild(item);
        });

        if (state.sessions.length > maxVisibleSessions) {
          toggleSessions.textContent = showAllSessions
            ? "Show Recent Sessions"
            : "Show All Sessions";
        } else {
          toggleSessions.textContent = "";
        }
      }

      function renderMessages() {
        messagesEl.innerHTML = "";
        const session = state.sessions.find((item) => item.id === state.activeSessionId);
        if (!session) {
          const empty = document.createElement("div");
          empty.className = "placeholder";
          empty.textContent = "Select a session to see messages.";
          messagesEl.appendChild(empty);
          return;
        }
        if (!session.messages.length) {
          const empty = document.createElement("div");
          empty.className = "placeholder";
          empty.textContent = "Start a conversation to see messages here.";
          messagesEl.appendChild(empty);
          return;
        }
        session.messages.forEach((message) => {
          const bubble = document.createElement("div");
          bubble.className = "message " + message.role;
          bubble.textContent = message.text;
          messagesEl.appendChild(bubble);
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function render() {
        renderSessions();
        renderMessages();
      }

      function formatDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return "";
        }
        return date.toLocaleString();
      }

      function sendMessage() {
        const text = input.value.trim();
        if (!text) {
          return;
        }
        vscode.postMessage({ type: "sendMessage", text });
        input.value = "";
      }

      sendButton.addEventListener("click", sendMessage);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          sendMessage();
        }
      });
      newSessionButton.addEventListener("click", () => {
        vscode.postMessage({ type: "createSession" });
      });
      toggleSessions.addEventListener("click", () => {
        if (state.sessions.length <= maxVisibleSessions) {
          return;
        }
        showAllSessions = !showAllSessions;
        renderSessions();
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "state") {
          return;
        }
        state = message.state;
        render();
      });

      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}
