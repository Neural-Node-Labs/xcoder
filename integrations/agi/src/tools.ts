import { Sandbox } from "./sandbox";
import { Memory } from "./memory";

export const TOOL_HELP: Record<string, string> = {
  bash: '{"cmd":"..."} run a bash command in your workspace (cwd)',
  write_file: '{"path":"rel/path","content":"..."} write a file in the workspace',
  read_file: '{"path":"rel/path"} read a file',
  skill_run: '{"name":"skill","args":["a","b"]} run a verified skill from the skill library',
};
export const TOOL_NAMES = Object.keys(TOOL_HELP);
const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const clip = (s: string, n = 3500) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);

export async function runTool(sb: Sandbox, mem: Memory, session: string, tool: string, args: Record<string, any>): Promise<string> {
  if (tool === "bash") {
    const r = await sb.exec(session, String(args.cmd ?? ""), 30_000);
    return clip(`exit=${r.code}${r.timedOut ? " (timed out)" : ""}\n${r.stdout}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}`);
  }
  if (tool === "write_file") { await sb.put(session, String(args.path), String(args.content ?? "")); return `written ${String(args.content ?? "").length} bytes to ${args.path}`; }
  if (tool === "read_file") return clip(await sb.read(session, String(args.path)));
  if (tool === "skill_run") {
    const s = mem.skill(String(args.name));
    if (!s) return "ERROR: unknown skill";
    await sb.put(session, ".skill.sh", s.script);
    const r = await sb.exec(session, `bash .skill.sh ${(Array.isArray(args.args) ? args.args : []).map((a: any) => q(String(a))).join(" ")}`, 30_000);
    return clip(`exit=${r.code}\n${r.stdout}${r.stderr}`);
  }
  return `ERROR: unknown tool ${tool}`;
}
