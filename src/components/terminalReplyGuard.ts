/* eslint-disable no-control-regex -- 识别终端转义序列必须匹配 ESC(0x1b) 控制字符，
   这是本模块的唯一职责；改用非正则只会让序列匹配更难读、更难验证。 */
/**
 * xterm 会对终端查询自动生成应答，并与用户键入共用 `term.onData` 回流通道。
 * agent / shell 不在读取窗口内时，这些应答会变成字面输入落进它的输入框
 * （issue #81：Codex 的 composer 里出现 `[?1;2c]10;rgb:cdcd/d6d6/f4f4\...`）。
 *
 * 生成乱码的三条应答（真实 xterm 6.0.0 实测）：
 *   ESC[c          → ESC[?1;2c          ConPTY 的 DA1 设备属性查询
 *   ESC]10;? ST    → ESC]10;rgb:...ST   Codex 前景色探测
 *   ESC]11;? ST    → ESC]11;rgb:...ST   Codex 背景色探测
 *
 * 为什么不能「见应答就丢」：OSC 10/11 的应答必须放行——#74 的浅色主题修复
 * 正依赖它（Codex 只有约 100ms 预算）。xterm 6 又未公开 `onUserInput`，
 * 无法直接区分「应答」与「键入」。
 *
 * 因此按因果放行：只有**紧跟在真实终端输出里出现的查询之后**的应答才放行。
 * - 应用自己发的查询（Codex 的 OSC 10/11、Claude 的 DA1）会出现在 PTY 输出流
 *   里，写入终端时被 `noteTerminalInput` 记录 → 开一个短窗口 → 应答放行；
 * - ConPTY 控制台宿主自己发的 DA1 查询不经过应用输出流，不会被记录 → 其应答被
 *   丢弃，这正是 `[?1;2c` 的来源；
 * - 终端重挂载回放历史输出（restore 直接 `term.write`，不走 writer）不会记录
 *   查询 → 回放触发的迟到应答同样被丢弃。
 */

/** 查询写入后允许应答回流的时间窗；xterm 应答实测在写入后 ~ms 内发出。 */
const REPLY_GRACE_MS = 500;

/** 会触发 xterm 生成应答的查询：DA1/DA2（`ESC[c` / `ESC[>c`）、OSC 10/11 颜色
 *  查询、DSR/光标位置请求（`ESC[6n`）。 */
const TERMINAL_QUERY_RE = /\x1b\[(?:>|\?)?[0-9;]*c|\x1b\]1[01];\?|\x1b\[[0-9;]*n/;

/** xterm 生成的应答序列。保持精确匹配（不接受夹杂其它字节），避免误伤用户
 *  键入或粘贴。DA1/DA2 与 CPR 是宿主→应用的报告，应用不会主动发出。 */
const TERMINAL_REPLY_RE =
  /^(?:\x1b\[\?[0-9;]*c|\x1b\[>[0-9;]*c|\x1b\[\d+;\d+R|\x1b\]1[01];rgb:[0-9a-fA-F]{1,4}(?:\/[0-9a-fA-F]{1,4}){2}(?:\x1b\\|\x07)?)$/;

export function isTerminalQuery(data: string): boolean {
  // 绝大多数输出块不含 ESC，先走原生快速路径。
  return data.indexOf("\x1b") !== -1 && TERMINAL_QUERY_RE.test(data);
}

export function isTerminalReply(data: string): boolean {
  return data.charCodeAt(0) === 0x1b && TERMINAL_REPLY_RE.test(data);
}

export interface TerminalReplyGuard {
  /** 记录一段**真实终端输出**（PTY→终端方向）刚被写入。restore/回放写入不要调用。 */
  noteTerminalInput(data: string): void;
  /** 判断一段从终端回流的数据是否放行给 PTY（agent/stdin 方向）。 */
  admit(data: string): boolean;
}

export function createTerminalReplyGuard(now: () => number = Date.now): TerminalReplyGuard {
  let replyWindowUntil = 0;
  return {
    noteTerminalInput(data) {
      if (isTerminalQuery(data)) replyWindowUntil = now() + REPLY_GRACE_MS;
    },
    admit(data) {
      if (!isTerminalReply(data)) return true;
      return now() <= replyWindowUntil;
    },
  };
}

/** 把 guard 的放行判定包在 onData 回流转发之外；TerminalView / ShellTerminalPanel
 *  用它包裹 `onInput`。 */
export function createGuardedForwarder(
  guard: TerminalReplyGuard,
  forward: (data: string) => void,
): (data: string) => void {
  return (data) => {
    if (guard.admit(data)) forward(data);
  };
}
