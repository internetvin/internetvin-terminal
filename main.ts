import { Plugin, ItemView, WorkspaceLeaf, App, TFile, setIcon, SuggestModal } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ChildProcess } from "child_process";

const VIEW_TYPE = "vin-terminal-view";

// --- WikiLinkAutocomplete ---
// Simpler approach: [[ passes through to the shell normally (user sees it typed).
// Dropdown appears overlaid. On accept we write "NoteName]]" to complete the link.
// On dismiss we just close the dropdown (the [[ is already in the shell).

interface AutocompleteEntry {
  name: string;        // display name (basename for files, link text for unresolved)
  folder: string;      // folder path for files, empty for unresolved
  isFile: boolean;     // true = existing file, false = unresolved link
  mtime: number;       // for sorting (0 for unresolved)
}

class WikiLinkAutocomplete {
  private app: App;
  private terminal: Terminal;
  private writeToShell: (data: string) => void;
  private active = false;
  private query = "";
  private results: AutocompleteEntry[] = [];
  private selectedIndex = 0;
  private lastCharWasBracket = false;
  private dropdownEl: HTMLElement | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private containerEl: HTMLElement;
  private previewEl: HTMLElement | null = null;
  private resizeDisposable: { dispose(): void } | null = null;

  constructor(app: App, terminal: Terminal, writeToShell: (data: string) => void, containerEl: HTMLElement) {
    this.app = app;
    this.terminal = terminal;
    this.writeToShell = writeToShell;
    this.containerEl = containerEl;

    // Intercept keys when autocomplete is active.
    // Nothing echoes to shell while active - user sees their typing in the dropdown header.
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Shift+Enter: send newline instead of carriage return
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        this.writeToShell("\n");
        return false;
      }

      if (!this.active) return true;
      if (e.type !== "keydown") return false;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.renderDropdown();
          return false;
        case "ArrowDown":
          e.preventDefault();
          this.selectedIndex = Math.min(this.results.length - 1, this.selectedIndex + 1);
          this.renderDropdown();
          return false;
        case "Enter":
        case "Tab":
          e.preventDefault();
          this.accept();
          return false;
        case "Escape":
          e.preventDefault();
          this.dismiss();
          return false;
        case "Backspace":
          e.preventDefault();
          if (this.query.length > 0) {
            this.query = this.query.slice(0, -1);
            this.filterResults();
          } else {
            this.dismiss();
          }
          return false;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            this.query += e.key;
            this.filterResults();
            return false;
          }
          return false;
      }
    });

    // Reposition on resize
    this.resizeDisposable = this.terminal.onResize(() => {
      if (this.active && this.dropdownEl) this.positionDropdown();
    });
  }

  /**
   * Called for every onData event. Detects [[ by tracking consecutive brackets.
   * Never consumes data - all chars go to shell normally.
   */
  handleData(data: string): void {
    if (this.active) return;

    // Check for [[ in pasted multi-char data
    if (data.length > 1) {
      if (data.includes("[[")) {
        this.activate();
      }
      this.lastCharWasBracket = data.endsWith("[");
      return;
    }

    // Single char: detect consecutive [[
    if (data === "[") {
      if (this.lastCharWasBracket) {
        this.lastCharWasBracket = false;
        this.activate();
      } else {
        this.lastCharWasBracket = true;
      }
    } else {
      this.lastCharWasBracket = false;
    }
  }

  private activate() {
    this.active = true;
    this.query = "";
    this.results = [];
    this.selectedIndex = 0;
    this.filterResults();
  }

  private accept() {
    if (this.results.length > 0 && this.selectedIndex < this.results.length) {
      const entry = this.results[this.selectedIndex];
      this.writeToShell(`${entry.name}]]`);
    } else if (this.query.length > 0) {
      // No match but user typed something - write it + close
      this.writeToShell(`${this.query}]]`);
    } else {
      this.writeToShell("]]");
    }
    this.deactivate();
  }

  private dismiss() {
    // Write whatever the user typed so far to shell so they don't lose it
    if (this.query.length > 0) {
      this.writeToShell(this.query);
    }
    this.deactivate();
  }

  private deactivate() {
    this.active = false;
    this.query = "";
    this.results = [];
    this.selectedIndex = 0;
    this.removeDropdown();
  }

  /** Gather all entries: real files + unresolved link targets */
  private getAllEntries(): AutocompleteEntry[] {
    const entries: AutocompleteEntry[] = [];
    const seen = new Set<string>();

    // Real files
    for (const f of this.app.vault.getFiles()) {
      entries.push({
        name: f.basename,
        folder: f.parent?.path || "",
        isFile: true,
        mtime: f.stat.mtime,
      });
      seen.add(f.basename.toLowerCase());
    }

    // Unresolved links from metadata cache
    const unresolved = (this.app.metadataCache as any).unresolvedLinks as Record<string, Record<string, number>> | undefined;
    if (unresolved) {
      for (const sourceFile of Object.values(unresolved)) {
        for (const linkTarget of Object.keys(sourceFile)) {
          const key = linkTarget.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            entries.push({
              name: linkTarget,
              folder: "",
              isFile: false,
              mtime: 0,
            });
          }
        }
      }
    }

    return entries;
  }

  private filterResults() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      const q = this.query.toLowerCase();
      const allEntries = this.getAllEntries();

      if (q.length === 0) {
        // Show recent files first, then unresolved
        this.results = allEntries
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 10);
      } else {
        const prefix: AutocompleteEntry[] = [];
        const contains: AutocompleteEntry[] = [];
        for (const entry of allEntries) {
          const name = entry.name.toLowerCase();
          if (name.startsWith(q)) prefix.push(entry);
          else if (name.includes(q)) contains.push(entry);
        }
        this.results = [...prefix, ...contains].slice(0, 10);
      }

      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.results.length - 1));
      this.renderDropdown();
    }, 16);
  }

  private renderDropdown() {
    if (!this.dropdownEl) {
      this.dropdownEl = document.createElement("div");
      this.dropdownEl.className = "vin-wikilink-dropdown";
      this.containerEl.appendChild(this.dropdownEl);
    }

    this.positionDropdown();

    let html = `<div class="vin-wikilink-header">[[${this.escapeHtml(this.query)}</div>`;

    if (this.results.length === 0) {
      html += `<div class="vin-wikilink-empty">No matches</div>`;
    } else {
      html += `<div class="vin-wikilink-list">`;
      this.results.forEach((entry, i) => {
        const selected = i === this.selectedIndex ? " is-selected" : "";
        const unresolvedCls = entry.isFile ? "" : " is-unresolved";
        html += `<div class="vin-wikilink-item${selected}${unresolvedCls}" data-index="${i}">`;
        html += `<span class="vin-wikilink-name">${this.escapeHtml(entry.name)}</span>`;
        if (entry.isFile && entry.folder && entry.folder !== "/") {
          html += `<span class="vin-wikilink-path">${this.escapeHtml(entry.folder)}</span>`;
        } else if (!entry.isFile) {
          html += `<span class="vin-wikilink-path">no file yet</span>`;
        }
        html += `</div>`;
      });
      html += `</div>`;
    }

    this.dropdownEl.innerHTML = html;

    this.dropdownEl.querySelectorAll(".vin-wikilink-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt((el as HTMLElement).dataset.index || "0", 10);
        this.selectedIndex = idx;
        this.accept();
      });
    });

    this.renderPreview();
  }

  private positionDropdown() {
    if (!this.dropdownEl) return;

    const buf = this.terminal.buffer.active;
    const cursorX = buf.cursorX;
    const cursorY = buf.cursorY;

    const screen = this.containerEl.querySelector(".xterm-screen");
    if (!screen) return;
    const screenRect = screen.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const cellW = screenRect.width / cols;
    const cellH = screenRect.height / rows;

    const offsetX = screenRect.left - containerRect.left;
    const offsetY = screenRect.top - containerRect.top;

    const dropdownWidth = 300; // approximate width to clamp against
    const dropdownHeight = 220;
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;

    // Horizontal: clamp so dropdown stays within container
    let left = offsetX + cursorX * cellW;
    if (left + dropdownWidth > containerWidth) {
      left = Math.max(4, containerWidth - dropdownWidth - 4);
    }

    // Vertical: prefer below cursor, flip above if not enough space
    const cursorBottom = offsetY + (cursorY + 1) * cellH;
    if ((containerHeight - cursorBottom) > dropdownHeight || cursorY < rows / 2) {
      this.dropdownEl.style.top = `${cursorBottom}px`;
      this.dropdownEl.style.bottom = "";
    } else {
      this.dropdownEl.style.bottom = `${containerHeight - (offsetY + cursorY * cellH)}px`;
      this.dropdownEl.style.top = "";
    }
    this.dropdownEl.style.left = `${left}px`;
  }

  private removeDropdown() {
    this.removePreview();
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  private async renderPreview() {
    const entry = this.results[this.selectedIndex];
    if (!entry || !entry.isFile) {
      this.removePreview();
      return;
    }

    if (!this.previewEl) {
      this.previewEl = document.createElement("div");
      this.previewEl.className = "vin-wikilink-preview";
      this.containerEl.appendChild(this.previewEl);
    }

    this.positionPreview();

    const file = this.app.vault.getAbstractFileByPath(
      entry.folder ? `${entry.folder}/${entry.name}.md` : `${entry.name}.md`
    );
    if (!file || !(file instanceof TFile)) {
      this.previewEl.innerHTML = `<div class="vin-preview-empty">File not found</div>`;
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const lines = content.split("\n").slice(0, 10);
    const preview = lines.join("\n");

    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache?.tags?.map(t => t.tag) ?? [];
    const frontmatterTags = cache?.frontmatter?.tags ?? [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    const resolved = (this.app.metadataCache as any).resolvedLinks ?? {};
    let backlinkCount = 0;
    for (const source of Object.keys(resolved)) {
      if (resolved[source]?.[file.path]) backlinkCount++;
    }

    const modified = new Date(file.stat.mtime);
    const dateStr = modified.toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric"
    });

    let html = `<div class="vin-preview-meta">`;
    html += `<span class="vin-preview-date">${dateStr}</span>`;
    html += `<span class="vin-preview-backlinks">${backlinkCount} backlink${backlinkCount !== 1 ? "s" : ""}</span>`;
    html += `</div>`;
    if (allTags.length > 0) {
      html += `<div class="vin-preview-tags">${allTags.map(t => `<span class="vin-preview-tag">${this.escapeHtml(String(t))}</span>`).join("")}</div>`;
    }
    html += `<div class="vin-preview-content">${this.escapeHtml(preview)}</div>`;
    this.previewEl.innerHTML = html;
  }

  private positionPreview() {
    if (!this.previewEl || !this.dropdownEl) return;
    const dropRect = this.dropdownEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    const previewWidth = 280;

    const rightSpace = containerRect.right - dropRect.right;
    if (rightSpace >= previewWidth) {
      this.previewEl.style.left = `${dropRect.right - containerRect.left + 4}px`;
    } else {
      this.previewEl.style.left = `${dropRect.left - containerRect.left - previewWidth - 4}px`;
    }
    this.previewEl.style.top = this.dropdownEl.style.top;
    this.previewEl.style.bottom = this.dropdownEl.style.bottom;
    this.previewEl.style.width = `${previewWidth}px`;
  }

  private removePreview() {
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  destroy() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.removePreview();
    this.removeDropdown();
    this.resizeDisposable?.dispose();
  }
}

// --- TerminalSession ---

class TerminalSession {
  terminal: Terminal;
  fitAddon: FitAddon;
  process: ChildProcess;
  containerEl: HTMLElement;
  id: number;
  name: string;
  app: App;
  textareaEl: HTMLTextAreaElement | null = null;
  private autocomplete: WikiLinkAutocomplete | null = null;

  constructor(parent: HTMLElement, id: number, cwd: string, app: App) {
    this.id = id;
    this.name = `zsh ${id}`;
    this.app = app;

    this.containerEl = parent.createDiv({ cls: "vin-terminal-session" });

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'GT America Mono', 'SF Mono', 'Fira Code', monospace",
      theme: {
        background: "#000000",
        foreground: "#D3D3D3",
        cursor: "#D3D3D3",
        cursorAccent: "#000000",
        selectionBackground: "rgba(211, 211, 211, 0.15)",
        selectionForeground: "#FFFFFF",
        // Muted ANSI palette to match Editorial's restrained aesthetic
        black: "#000000",
        red: "#A06060",
        green: "#7A9A6A",
        yellow: "#B0A070",
        blue: "#6080A0",
        magenta: "#8A7090",
        cyan: "#608888",
        white: "#D3D3D3",
        brightBlack: "#393939",
        brightRed: "#C08080",
        brightGreen: "#9ABA8A",
        brightYellow: "#D0C090",
        brightBlue: "#80A0C0",
        brightMagenta: "#AA90B0",
        brightCyan: "#80A8A8",
        brightWhite: "#FFFFFF",
      },
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.containerEl);

    // Grab the hidden textarea xterm.js creates for input
    this.textareaEl = this.containerEl.querySelector(".xterm-helper-textarea");

    // Spawn zsh inside a real PTY via Python helper.
    // The helper accepts resize commands so the shell reflows to fit the panel.
    const { spawn } = require("child_process");
    const path = require("path");
    const vaultBase = (app.vault.adapter as any).basePath as string;
    const helperScript = path.join(vaultBase, ".obsidian", "plugins", "internetvin-terminal", "pty-helper.py");

    // Strip CLAUDECODE env var so Claude Code can be launched inside the terminal
    const { CLAUDECODE, ...cleanEnv } = process.env;
    this.process = spawn("python3", [helperScript], {
      cwd,
      env: {
        ...cleanEnv,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        VIN_TERM_COLS: "80",
        VIN_TERM_ROWS: "24",
      },
    });

    // Wiki-link autocomplete
    this.autocomplete = new WikiLinkAutocomplete(
      app, this.terminal, (data: string) => this.process.stdin?.write(data), this.containerEl
    );

    // Wire I/O
    this.terminal.onData((data) => {
      this.autocomplete?.handleData(data);
      this.process.stdin?.write(data);
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.terminal.write(data);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.terminal.write(data);
    });

    this.process.on("exit", () => {
      this.terminal.write("\r\n[Process exited]\r\n");
    });

    // When xterm.js changes cols/rows after a fit, tell the PTY
    this.terminal.onResize(({ cols, rows }) => {
      this.process.stdin?.write(`\x1b]R;${cols};${rows}\x07`);
    });

    // Initial fit after a tick (container needs to be laid out)
    setTimeout(() => this.fit(), 50);

    // Drag-and-drop: accept files dragged onto the terminal and paste their paths.
    // Use capture phase so events reach the terminal before Obsidian's workspace
    // handlers can intercept them.
    const captureOpt = { capture: true };
    let dragCounter = 0;
    this.containerEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }, captureOpt);

    this.containerEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) this.showDropZone();
    }, captureOpt);

    this.containerEl.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        this.hideDropZone();
      }
    }, captureOpt);

    this.containerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      this.hideDropZone();
      this.handleDrop(e);
    }, captureOpt);
  }

  private dropZoneEl: HTMLElement | null = null;
  private dropBadgeTimer: ReturnType<typeof setTimeout> | null = null;

  private showDropZone() {
    if (this.dropZoneEl) return;
    this.dropZoneEl = document.createElement("div");
    this.dropZoneEl.className = "vin-terminal-dropzone";
    this.dropZoneEl.innerHTML = `<span class="vin-dropzone-label">Drop file here</span>`;
    this.containerEl.appendChild(this.dropZoneEl);
    // Trigger animation on next frame
    requestAnimationFrame(() => this.dropZoneEl?.addClass("is-visible"));
  }

  private hideDropZone() {
    if (!this.dropZoneEl) return;
    this.dropZoneEl.remove();
    this.dropZoneEl = null;
  }

  private showDropBadge(filePaths: string[]) {
    // Clear any existing badge
    if (this.dropBadgeTimer) clearTimeout(this.dropBadgeTimer);
    this.containerEl.querySelector(".vin-drop-badge")?.remove();

    const pathMod = require("path");
    const badge = document.createElement("div");
    badge.className = "vin-drop-badge";

    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

    for (const fp of filePaths) {
      const item = document.createElement("div");
      item.className = "vin-drop-badge-item";

      const ext = pathMod.extname(fp).toLowerCase();
      const basename = pathMod.basename(fp);

      if (IMAGE_EXTS.has(ext)) {
        const thumb = document.createElement("img");
        thumb.className = "vin-drop-badge-thumb";
        thumb.src = `file://${fp}`;
        item.appendChild(thumb);
      }

      const nameEl = document.createElement("span");
      nameEl.className = "vin-drop-badge-name";
      nameEl.textContent = basename;
      item.appendChild(nameEl);

      badge.appendChild(item);
    }

    this.containerEl.appendChild(badge);
    requestAnimationFrame(() => badge.addClass("is-visible"));

    this.dropBadgeTimer = setTimeout(() => {
      badge.removeClass("is-visible");
      setTimeout(() => badge.remove(), 300);
    }, 3000);
  }

  /** Handle a drop event: extract file paths and write them to the shell */
  private handleDrop(e: DragEvent) {
    const paths: string[] = [];
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const pathMod = require("path");

    // 1. Native filesystem files (dragged from Finder, desktop, etc.)
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if ((file as any).path) {
          paths.push((file as any).path);
        }
      }
    }

    // 2. In-memory image data (e.g. macOS screenshot thumbnail dragged before
    //    it's saved to disk). The File object exists but has no .path.
    //    Read the blob, write it to a temp file, then paste that path.
    if (paths.length === 0 && e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      const imageFiles: File[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if (file.type.startsWith("image/")) {
          imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        this.saveDroppedImages(imageFiles);
        return; // async path handles writing to shell
      }
    }

    // 3. Obsidian internal files (dragged from the file explorer sidebar).
    //    Obsidian sets multiple data types; try them in order of specificity.
    if (paths.length === 0 && e.dataTransfer) {
      let relativePath = "";

      // Obsidian may set the vault-relative path in text/plain
      const plain = e.dataTransfer.getData("text/plain")?.trim();
      if (plain && !plain.startsWith("http") && !plain.startsWith("data:")) {
        relativePath = plain;
      }

      // Also check text/uri-list (Obsidian sometimes uses file:// URIs)
      if (!relativePath) {
        const uriList = e.dataTransfer.getData("text/uri-list")?.trim();
        if (uriList) {
          for (const uri of uriList.split("\n")) {
            const trimmed = uri.trim();
            if (trimmed.startsWith("file://")) {
              try {
                paths.push(decodeURIComponent(trimmed.replace("file://", "")));
              } catch { /* skip malformed URIs */ }
            } else if (trimmed.startsWith("app://")) {
              // Obsidian app:// URIs encode vault-relative paths
              const match = trimmed.match(/app:\/\/[^/]+\/(.+)/);
              if (match) {
                paths.push(pathMod.join(vaultPath, decodeURIComponent(match[1])));
              }
            }
          }
        }
      }

      if (relativePath && paths.length === 0) {
        paths.push(pathMod.join(vaultPath, relativePath));
      }
    }

    if (paths.length === 0) return;

    // Shell-escape paths and join with spaces
    const escaped = paths.map((p) => this.shellEscape(p)).join(" ");
    this.process.stdin?.write(escaped);

    // Show confirmation badge
    this.showDropBadge(paths);
  }

  /** Save in-memory image blobs (e.g. macOS screenshot thumbnails) to tmp files,
   *  then paste the paths into the shell. */
  private async saveDroppedImages(files: File[]) {
    const os = require("os");
    const fs = require("fs");
    const pathMod = require("path");
    const saved: string[] = [];

    for (const file of files) {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `drop-${ts}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const tmpPath = pathMod.join(os.tmpdir(), name);

      try {
        const buf = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(tmpPath, buf);
        saved.push(tmpPath);
      } catch (err) {
        console.error("[vin-terminal] failed to save dropped image:", err);
      }
    }

    if (saved.length === 0) return;

    const escaped = saved.map((p: string) => this.shellEscape(p)).join(" ");
    this.process.stdin?.write(escaped);
    this.showDropBadge(saved);
  }

  /** Escape a file path for safe insertion into a shell command */
  private shellEscape(p: string): string {
    if (/^[a-zA-Z0-9_.\/\-]+$/.test(p)) return p;
    return "'" + p.replace(/'/g, "'\\''") + "'";
  }

  captureOutput(): string {
    const sel = this.terminal.getSelection();
    if (sel && sel.trim().length > 0) return sel;
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buf.length - 50);
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i)?.translateToString(true);
      if (line !== undefined) lines.push(line);
    }
    return lines.join("\n").trimEnd();
  }

  fit() {
    try {
      this.fitAddon.fit();
    } catch {
      // Container may not be visible yet
    }
  }

  focus() {
    // Retry focus until it actually takes (container may not be laid out yet)
    const attempt = (retries: number) => {
      if (this.textareaEl) {
        this.textareaEl.focus({ preventScroll: true });
      } else {
        this.terminal.focus();
      }
      if (document.activeElement !== this.textareaEl && retries > 0) {
        requestAnimationFrame(() => attempt(retries - 1));
      }
    };
    attempt(10);
  }

  show(skipFocus = false) {
    this.containerEl.addClass("is-active");
    requestAnimationFrame(() => {
      this.fit();
      if (!skipFocus) this.focus();
    });
  }

  hide() {
    this.containerEl.removeClass("is-active");
  }

  destroy() {
    this.autocomplete?.destroy();
    try {
      this.process.kill("SIGTERM");
    } catch {
      // Already dead
    }
    this.terminal.dispose();
    this.containerEl.remove();
  }
}

// --- FullscreenManager ---

type FullscreenLayout = "single" | "split-h" | "split-v" | "grid";

interface SavedPosition {
  parent: HTMLElement;
  nextSibling: Node | null;
}

class FullscreenManager {
  private static overlayOpen = false;

  private view: TerminalView;
  private overlay: HTMLElement | null = null;
  private tabBarEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private savedPositions = new Map<TerminalSession, SavedPosition>();
  private layout: FullscreenLayout = "single";
  private focusedSession: TerminalSession | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private isRenaming = false;

  constructor(view: TerminalView) {
    this.view = view;
  }

  get isOpen() {
    return this.overlay !== null;
  }

  toggle() {
    if (this.isOpen) {
      this.exit();
    } else {
      this.enter();
    }
  }

  enter(layout?: FullscreenLayout) {
    if (this.isOpen || FullscreenManager.overlayOpen) return;
    if (this.view.sessions.length === 0) return;

    FullscreenManager.overlayOpen = true;
    if (layout) this.layout = layout;

    // Always sync focused session from the view's current active session
    this.focusedSession = this.view.activeSession ?? this.view.sessions[0];

    // Build overlay DOM
    this.overlay = document.createElement("div");
    this.overlay.className = "vin-fullscreen-overlay";

    // Tab bar (iTerm-style: tabs + layout switcher + actions, all in one bar)
    this.tabBarEl = document.createElement("div");
    this.tabBarEl.className = "vin-fs-tab-bar";
    this.overlay.appendChild(this.tabBarEl);

    // Grid container
    this.gridEl = document.createElement("div");
    this.gridEl.className = "vin-fullscreen-grid";
    this.gridEl.dataset.layout = this.layout;
    this.overlay.appendChild(this.gridEl);

    // Stop keyboard events from bubbling to Obsidian
    this.overlay.addEventListener("keydown", (e) => {
      if (!e.metaKey) e.stopPropagation();
    });
    this.overlay.addEventListener("wheel", (e) => e.stopPropagation());

    // Escape to exit (only when autocomplete is not active)
    this.overlay.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.isRenaming) {
        const anyAutocomplete = this.view.sessions.some(
          (s) => (s as any).autocomplete?.active
        );
        if (!anyAutocomplete) {
          e.preventDefault();
          e.stopPropagation();
          this.exit();
        }
      }
    });

    // Save positions and move sessions into panes
    this.saveAndMoveAll();

    // Append to body
    document.body.appendChild(this.overlay);

    // Animate in
    requestAnimationFrame(() => this.overlay?.classList.add("is-visible"));

    // ResizeObserver on grid
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.fitAllVisible(), 60);
    });
    this.resizeObserver.observe(this.gridEl);

    // Fit after layout settles
    setTimeout(() => this.fitAllVisible(), 100);
  }

  exit() {
    if (!this.overlay) return;

    // Immediately stop blocking clicks and start fade
    this.overlay.style.pointerEvents = "none";
    this.overlay.classList.remove("is-visible");

    // Remove overlay after fade animation
    const overlay = this.overlay;
    setTimeout(() => overlay.remove(), 150);

    // Clear refs immediately so re-entry works
    this.overlay = null;
    this.tabBarEl = null;
    this.gridEl = null;
    FullscreenManager.overlayOpen = false;

    // Restore sessions to their original containers
    try {
      this.restoreAll();
    } catch (e) {
      console.error("[vin-terminal] restoreAll error:", e);
    }

    // Clean up observer
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);

    // Sync active session back to view
    // Force switchTo by clearing activeSession first
    const target = (this.focusedSession && this.view.sessions.includes(this.focusedSession))
      ? this.focusedSession
      : this.view.sessions[0] || null;
    this.view.activeSession = null;
    if (target) this.view.switchTo(target);
    this.view.renderTabs();

    // Refit after DOM settles
    requestAnimationFrame(() => {
      this.view.activeSession?.fit();
      this.view.activeSession?.focus();
    });
  }

  setLayout(layout: FullscreenLayout) {
    if (layout === this.layout && this.gridEl) return;
    this.layout = layout;
    if (this.gridEl) this.gridEl.dataset.layout = layout;
    this.renderFsTabs();
    this.rebuildPanes();
  }

  private saveAndMoveAll() {
    this.savedPositions.clear();

    // Save original DOM positions for ALL sessions so we can restore them on exit
    for (const session of this.view.sessions) {
      const parent = session.containerEl.parentElement;
      if (parent) {
        this.savedPositions.set(session, {
          parent,
          nextSibling: session.containerEl.nextSibling,
        });
      }
    }

    this.renderFsTabs();
    this.rebuildPanes();
  }

  /** Render the fullscreen tab bar: session tabs | layout switcher | actions */
  private renderFsTabs() {
    if (!this.tabBarEl || this.isRenaming) return;
    while (this.tabBarEl.firstChild) this.tabBarEl.removeChild(this.tabBarEl.firstChild);

    // Session tabs
    const tabsArea = document.createElement("div");
    tabsArea.className = "vin-fs-tabs";

    for (const session of this.view.sessions) {
      const tab = document.createElement("div");
      tab.className = "vin-fs-tab";
      if (session === this.focusedSession) tab.classList.add("is-active");

      const label = document.createElement("span");
      label.className = "vin-fs-tab-label";
      label.textContent = session.name;
      tab.appendChild(label);

      const renameBtn = document.createElement("span");
      renameBtn.className = "vin-fs-tab-btn";
      setIcon(renameBtn, "pencil");
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startTabRename(tab, label, session);
      });
      tab.appendChild(renameBtn);

      if (this.view.sessions.length > 1) {
        const closeBtn = document.createElement("span");
        closeBtn.className = "vin-fs-tab-btn vin-fs-tab-close";
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.view.closeSession(session);
          this.savedPositions.delete(session);
          if (this.focusedSession === session) {
            this.focusedSession = this.view.sessions[this.view.sessions.length - 1] || null;
          }
          this.renderFsTabs();
          this.rebuildPanes();
        });
        tab.appendChild(closeBtn);
      }

      tab.addEventListener("click", () => {
        if (this.isRenaming) return;
        this.focusedSession = session;
        this.renderFsTabs();
        this.rebuildPanes();
      });

      tabsArea.appendChild(tab);
    }

    // New session button
    const newTab = document.createElement("div");
    newTab.className = "vin-fs-tab-new";
    newTab.textContent = "+";
    newTab.addEventListener("click", () => {
      this.view.createSession();
      const newest = this.view.sessions[this.view.sessions.length - 1];
      // Save position for the new session
      this.savedPositions.set(newest, {
        parent: newest.containerEl.parentElement!,
        nextSibling: newest.containerEl.nextSibling,
      });
      this.focusedSession = newest;
      this.renderFsTabs();
      this.rebuildPanes();
    });
    tabsArea.appendChild(newTab);

    this.tabBarEl.appendChild(tabsArea);

    // Right side: layout switcher + exit
    const controls = document.createElement("div");
    controls.className = "vin-fs-controls";

    // Layout switcher
    const layoutGroup = document.createElement("div");
    layoutGroup.className = "vin-fs-layout-group";

    const layouts: { key: FullscreenLayout; label: string; svg: string }[] = [
      { key: "single", label: "Single", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' },
      { key: "split-h", label: "Side by side", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/></svg>' },
      { key: "split-v", label: "Stacked", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid", label: "Grid", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
    ];

    for (const l of layouts) {
      const btn = document.createElement("button");
      btn.className = "vin-fs-layout-btn";
      if (l.key === this.layout) btn.classList.add("is-active");
      btn.innerHTML = l.svg;
      btn.title = l.label;
      btn.addEventListener("click", () => this.setLayout(l.key));
      layoutGroup.appendChild(btn);
    }
    controls.appendChild(layoutGroup);

    // Exit button
    const exitBtn = document.createElement("button");
    exitBtn.className = "vin-fs-exit-btn";
    setIcon(exitBtn, "minimize-2");
    exitBtn.title = "Exit fullscreen";
    exitBtn.addEventListener("click", () => this.exit());
    controls.appendChild(exitBtn);

    this.tabBarEl.appendChild(controls);
  }

  private startTabRename(tab: HTMLElement, label: HTMLSpanElement, session: TerminalSession) {
    this.isRenaming = true;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "vin-fs-tab-rename";
    input.style.width = `${session.name.length + 1}ch`;

    // Hide buttons while renaming
    tab.querySelectorAll(".vin-fs-tab-btn").forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
    label.replaceWith(input);

    input.addEventListener("input", () => {
      input.style.width = `${input.value.length + 1}ch`;
    });

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      this.isRenaming = false;
      if (save) {
        const name = input.value.trim();
        if (name) session.name = name;
      }
      this.renderFsTabs();
      this.rebuildPanes();
      this.view.renderTabs();
      this.view.saveState();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));

    input.focus();
    input.select();
  }

  /** Rebuild the grid panes based on current layout and sessions */
  private rebuildPanes() {
    if (!this.gridEl || this.isRenaming) return;

    // Detach sessions from panes before clearing (so they don't get destroyed)
    while (this.gridEl.firstChild) this.gridEl.removeChild(this.gridEl.firstChild);

    const visibleSessions = this.getVisibleSessions();
    const visibleSet = new Set(visibleSessions);
    const multiPane = visibleSessions.length > 1;

    // Hide non-visible sessions (park them off-screen in overlay so they're not orphaned)
    for (const session of this.view.sessions) {
      if (!visibleSet.has(session)) {
        session.containerEl.classList.remove("is-active");
        session.containerEl.style.display = "none";
        this.overlay?.appendChild(session.containerEl);
      }
    }

    for (const session of visibleSessions) {
      const pane = document.createElement("div");
      pane.className = "vin-fullscreen-pane";
      if (session === this.focusedSession) pane.classList.add("is-focused");

      // Show a thin label in multi-pane layouts so you know which is which
      if (multiPane) {
        const label = document.createElement("div");
        label.className = "vin-fullscreen-pane-label";
        label.textContent = session.name;
        pane.appendChild(label);
      }

      session.containerEl.style.display = "";
      session.containerEl.classList.add("is-active");
      pane.appendChild(session.containerEl);

      // Click pane to focus it
      pane.addEventListener("mousedown", () => {
        if (this.focusedSession !== session) {
          this.focusedSession = session;
          this.gridEl?.querySelectorAll(".vin-fullscreen-pane").forEach((p) => {
            p.classList.toggle("is-focused", p === pane);
          });
          this.renderFsTabs();
        }
        session.focus();
      });

      this.gridEl.appendChild(pane);
    }

    requestAnimationFrame(() => this.fitAllVisible());
  }

  private getVisibleSessions(): TerminalSession[] {
    const all = this.view.sessions;
    if (all.length === 0) return [];

    switch (this.layout) {
      case "single":
        return this.focusedSession && all.includes(this.focusedSession)
          ? [this.focusedSession]
          : [all[0]];
      case "split-h":
      case "split-v":
        if (all.length === 1) return [all[0]];
        if (this.focusedSession) {
          const idx = all.indexOf(this.focusedSession);
          const other = all[(idx + 1) % all.length];
          return this.focusedSession === other ? [this.focusedSession] : [this.focusedSession, other];
        }
        return all.slice(0, 2);
      case "grid":
        return [...all];
    }
  }

  private fitAllVisible() {
    if (!this.gridEl) return;
    const sessions = this.getVisibleSessions();
    for (const session of sessions) {
      session.fit();
    }
    // Don't steal focus from rename input
    if (!this.isRenaming && this.focusedSession && sessions.includes(this.focusedSession)) {
      this.focusedSession.focus();
    }
  }

  private restoreAll() {
    for (const [session, saved] of this.savedPositions) {
      // Reset any inline display override
      session.containerEl.style.display = "";
      try {
        if (saved.nextSibling && saved.nextSibling.parentNode === saved.parent) {
          saved.parent.insertBefore(session.containerEl, saved.nextSibling);
        } else {
          saved.parent.appendChild(session.containerEl);
        }
      } catch {
        // Fallback: put it back in the sessions container
        this.view.sessionsEl.appendChild(session.containerEl);
      }
    }

    // Also restore any sessions not in savedPositions (created during fullscreen)
    for (const session of this.view.sessions) {
      if (!this.savedPositions.has(session)) {
        session.containerEl.style.display = "";
        this.view.sessionsEl.appendChild(session.containerEl);
      }
      session.hide();
    }
    this.savedPositions.clear();
  }

  destroy() {
    if (this.isOpen) {
      // Quick exit without animation
      this.restoreAll();
      this.resizeObserver?.disconnect();
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.overlay?.remove();
      this.overlay = null;
      this.tabBarEl = null;
      this.gridEl = null;
      FullscreenManager.overlayOpen = false;
    }
  }
}

// --- TerminalView ---

class TerminalView extends ItemView {
  sessions: TerminalSession[] = [];
  activeSession: TerminalSession | null = null;
  nextId = 1;
  tabBarEl!: HTMLElement;
  sessionsEl!: HTMLElement;
  resizeObserver: ResizeObserver | null = null;
  fullscreenManager: FullscreenManager | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private isRenaming = false;

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Terminal"; }
  getIcon() { return "terminal"; }

  getState() {
    return {
      sessions: this.sessions.map((s) => ({ id: s.id, name: s.name })),
      activeId: this.activeSession?.id ?? null,
      nextId: this.nextId,
    };
  }

  async setState(state: any, result: any) {
    if (state?.sessions?.length > 0) {
      // Destroy default session created by onOpen
      for (const s of this.sessions) s.destroy();
      this.sessions = [];
      this.activeSession = null;
      this.nextId = state.nextId ?? 1;

      for (const saved of state.sessions) {
        const id = saved.id ?? this.nextId++;
        if (id >= this.nextId) this.nextId = id + 1;
        const vaultPath = (this.app.vault.adapter as any).basePath as string;
        const session = new TerminalSession(this.sessionsEl, id, vaultPath, this.app);
        session.name = saved.name ?? `zsh ${id}`;
        this.sessions.push(session);
        session.hide();
      }

      const target = this.sessions.find((s) => s.id === state.activeId) ?? this.sessions[0];
      if (target) this.switchTo(target);
      this.renderTabs();
    }
    return super.setState(state, result);
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("vin-terminal-container");

    // Stop keyboard events from bubbling to Obsidian hotkeys while typing
    // in the terminal. Uses bubble phase so xterm.js receives the event first,
    // then we stop it before Obsidian can act on it. Cmd+key combos are let
    // through so Cmd+Q, Cmd+W, etc. still work.
    container.addEventListener("keydown", (e) => {
      if (!e.metaKey) {
        e.stopPropagation();
      }
    });

    // Capture all wheel/scroll events so Obsidian doesn't intercept them.
    // This ensures scrollback, interactive programs (less, man, y/n prompts),
    // and mouse-aware TUI apps work correctly.
    container.addEventListener("wheel", (e) => {
      e.stopPropagation();
    });

    // Click to focus the terminal textarea.
    container.addEventListener("mousedown", (e) => {
      // Don't steal focus from tab bar buttons
      if ((e.target as HTMLElement).closest(".vin-terminal-tab-bar")) return;
      setTimeout(() => this.activeSession?.focus(), 0);
    });

    // Tab bar
    this.tabBarEl = container.createDiv({ cls: "vin-terminal-tab-bar" });

    // Sessions container
    this.sessionsEl = container.createDiv({ cls: "vin-terminal-sessions" });

    // Resize observer to refit active terminal (debounced for smooth dragging)
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.activeSession?.fit(), 60);
    });
    this.resizeObserver.observe(this.sessionsEl);

    // Fullscreen manager
    this.fullscreenManager = new FullscreenManager(this);

    // Create first session (setState will replace this if restoring)
    this.createSession();
  }

  createSession(name?: string) {
    const id = this.nextId++;
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const session = new TerminalSession(this.sessionsEl, id, vaultPath, this.app);
    if (name) session.name = name;
    this.sessions.push(session);
    this.switchTo(session);
    this.renderTabs();
    this.saveState();
  }

  saveState() {
    this.app.workspace.requestSaveLayout();
  }

  switchTo(session: TerminalSession) {
    if (session === this.activeSession) return;
    if (this.activeSession) {
      this.activeSession.hide();
    }
    this.activeSession = session;
    session.show(this.isRenaming);
    this.renderTabs();
    this.saveState();
  }

  closeSession(session: TerminalSession) {
    session.destroy();
    this.sessions = this.sessions.filter((s) => s !== session);

    if (this.activeSession === session) {
      this.activeSession = null;
      if (this.sessions.length > 0) {
        this.switchTo(this.sessions[this.sessions.length - 1]);
      }
    }
    this.renderTabs();
    this.saveState();
  }

  renderTabs() {
    // Don't rebuild tabs while the user is typing a name
    if (this.isRenaming) return;

    this.tabBarEl.empty();

    this.sessions.forEach((session) => {
      const tab = this.tabBarEl.createDiv({ cls: "vin-terminal-tab" });
      if (session === this.activeSession) tab.addClass("is-active");

      const label = tab.createSpan({ cls: "tab-label", text: session.name });

      const renameBtn = tab.createSpan({ cls: "rename-btn" });
      setIcon(renameBtn, "pencil");
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startRename(tab, label, session);
      });

      const closeBtn = tab.createSpan({ cls: "close-btn" });
      setIcon(closeBtn, "x");
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeSession(session);
      });

      tab.addEventListener("click", () => this.switchTo(session));
    });

    const newBtn = this.tabBarEl.createDiv({ cls: "vin-terminal-tab-new", text: "+" });
    newBtn.addEventListener("click", () => this.createSession());

    const fsBtn = this.tabBarEl.createDiv({ cls: "vin-terminal-tab-fullscreen" });
    setIcon(fsBtn, "expand");
    fsBtn.title = "Fullscreen";
    fsBtn.addEventListener("click", () => this.fullscreenManager?.toggle());
  }

  private startRename(tab: HTMLElement, label: HTMLSpanElement, session: TerminalSession) {
    this.isRenaming = true;

    // Replace only the label text with an input, keep tab structure intact
    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "vin-terminal-tab-rename";
    input.style.width = `${session.name.length + 1}ch`;

    // Hide icons while renaming
    const renameBtn = tab.querySelector(".rename-btn") as HTMLElement | null;
    const closeBtn = tab.querySelector(".close-btn") as HTMLElement | null;
    if (renameBtn) renameBtn.style.display = "none";
    if (closeBtn) closeBtn.style.display = "none";

    // Replace label with input
    label.replaceWith(input);

    // Grow/shrink as user types
    input.addEventListener("input", () => {
      input.style.width = `${input.value.length + 1}ch`;
    });

    const finish = (save: boolean) => {
      if (!this.isRenaming) return;
      this.isRenaming = false;
      if (save) {
        const name = input.value.trim();
        if (name) session.name = name;
      }
      this.renderTabs();
      this.saveState();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));

    input.focus();
    input.select();
  }

  async onClose() {
    this.fullscreenManager?.destroy();
    this.fullscreenManager = null;
    this.resizeObserver?.disconnect();
    for (const session of this.sessions) {
      session.destroy();
    }
    this.sessions = [];
    this.activeSession = null;
  }
}

// --- OutputCaptureModal ---

interface CaptureOption {
  label: string;
  action: string;
}

class OutputCaptureModal extends SuggestModal<CaptureOption> {
  private capturedText: string;

  constructor(app: App, capturedText: string) {
    super(app);
    this.capturedText = capturedText;
    this.setPlaceholder("Choose where to save terminal output...");
  }

  getSuggestions(): CaptureOption[] {
    return [
      { label: "Today's daily note", action: "daily" },
      { label: "Current open note", action: "current" },
      { label: "New note", action: "new" },
    ];
  }

  renderSuggestion(option: CaptureOption, el: HTMLElement) {
    el.createEl("div", { text: option.label });
  }

  async onChooseSuggestion(option: CaptureOption) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const block = `\n## Terminal Capture — ${hh}:${mm}\n\n\`\`\`\n${this.capturedText}\n\`\`\`\n`;

    if (option.action === "daily") {
      const yyyy = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const dailyPath = `Daily Notes/${yyyy}-${mo}-${dd}.md`;

      const exists = await this.app.vault.adapter.exists(dailyPath);
      if (exists) {
        await this.app.vault.adapter.append(dailyPath, block);
      } else {
        await this.app.vault.create(dailyPath, block.trimStart());
      }
    } else if (option.action === "current") {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        await this.app.vault.adapter.append(activeFile.path, block);
      }
    } else if (option.action === "new") {
      const ss = String(now.getSeconds()).padStart(2, "0");
      const yyyy = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const newPath = `Terminal Captures/${yyyy}-${mo}-${dd}-${hh}${mm}${ss}.md`;

      const folderExists = await this.app.vault.adapter.exists("Terminal Captures");
      if (!folderExists) {
        await this.app.vault.createFolder("Terminal Captures");
      }
      await this.app.vault.create(newPath, block.trimStart());
    }
  }
}

// --- Plugin ---

export default class TerminalPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf));

    this.addRibbonIcon("terminal", "Open Terminal", () => {
      this.toggleTerminalSide();
    });

    this.addCommand({
      id: "open-terminal",
      name: "Open Terminal",
      callback: () => this.toggleTerminalSide(),
    });

    this.addCommand({
      id: "open-terminal-tab",
      name: "Open Terminal in Tab",
      callback: () => this.openTerminalTab(),
    });

    this.addCommand({
      id: "toggle-fullscreen",
      name: "Toggle Fullscreen Terminal",
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          view.fullscreenManager?.toggle();
        }
      },
    });

    this.addCommand({
      id: "capture-terminal-output",
      name: "Capture Terminal Output to Note",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length === 0) return;
        const view = leaves[0].view as TerminalView;
        const session = view.activeSession;
        if (!session) return;
        const text = session.captureOutput();
        if (!text.trim()) return;
        new OutputCaptureModal(this.app, text).open();
      },
    });

    // Ensure a terminal leaf exists in the right sidebar on startup
    this.app.workspace.onLayoutReady(() => this.ensureLeaf());
  }

  private async ensureLeaf() {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: false });
    }
  }

  async toggleTerminalSide() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      // If it's already visible/active, hide the sidebar. Otherwise reveal it.
      const leaf = existing[0];
      const isVisible = leaf.view.containerEl.isShown();
      if (isVisible) {
        // Check if it's the active leaf in the right split
        const parent = leaf.view.containerEl.closest(".workspace-split");
        if (parent && !parent.classList.contains("is-collapsed")) {
          this.app.workspace.rightSplit.collapse();
          return;
        }
      }
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    await this.ensureLeaf();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
    }
  }

  async openTerminalTab() {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}
