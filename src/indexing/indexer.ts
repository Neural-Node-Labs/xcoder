import fs from "node:fs";
import path from "node:path";
import { globTool } from "../tools/globTool.js";
import { loadIgnoreRules } from "./ignoreRules.js";
import { IndexEntry, IndexFile } from "../core/types.js";

const MAX_DUMP_BYTES = 500 * 1024; // 500KB na hard ceiling bawat dump file
const INDEX_DIR = ".agent/index";

/**
 * Nilalakad ang workspace (sinusunod ang .agentignore/.gitignore/.dockerignore), at idinadaan
 * ang laman ng bawat file papunta sa mga naka-chunk na index00x.dump file, bawat isa ay
 * minamarkahan para maibalik ang orihinal na file, habang sinusubaybayan ng index.json ang
 * filename -> (dump file, start byte, end byte).
 *
 * Ginagamit ang byte offsets (sa halip na mga numero ng linya) para eksakto sa byte ang
 * pagbuo ng file anuman ang line-ending style nito (LF kumpara sa CRLF).
 */
export async function buildIndex(cwd: string = process.cwd()): Promise<IndexFile> {
  const indexDirAbs = path.join(cwd, INDEX_DIR);
  fs.mkdirSync(indexDirAbs, { recursive: true });

  // fresh rebuild: burahin ang mga lumang dump file
  for (const f of fs.readdirSync(indexDirAbs)) {
    if (f.startsWith("index") && f.endsWith(".dump")) fs.unlinkSync(path.join(indexDirAbs, f));
  }

  loadIgnoreRules(cwd); // tinitiyak na nangyayari ang pagsasama ng ignore file kahit mag-cache ang globTool sa ibang pagkakataon
  const files = await globTool("**/*", cwd);

  const entries: IndexEntry[] = [];
  let dumpIndex = 1;
  let currentDumpPath = path.join(indexDirAbs, dumpFileName(dumpIndex));
  let currentDumpSize = 0;
  let currentStream = fs.createWriteStream(currentDumpPath, { flags: "w" });

  for (const relPath of files) {
    const abs = path.join(cwd, relPath);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      continue; // laktawan ang mga binary/hindi-mabasang file
    }

    const marker = `>>> FILE: ${relPath} >>>\n`;
    const endMarker = `<<< END: ${relPath} <<<\n`;
    const block = marker + content + (content.endsWith("\n") ? "" : "\n") + endMarker;
    const blockBytes = Buffer.byteLength(block, "utf-8");
    const markerBytes = Buffer.byteLength(marker, "utf-8");
    const contentBytes = Buffer.byteLength(content, "utf-8");

    // lumipat sa bagong dump file kung lalampas ang block na ito sa cap
    if (currentDumpSize + blockBytes > MAX_DUMP_BYTES && currentDumpSize > 0) {
      currentStream.end();
      dumpIndex += 1;
      currentDumpPath = path.join(indexDirAbs, dumpFileName(dumpIndex));
      currentStream = fs.createWriteStream(currentDumpPath, { flags: "w" });
      currentDumpSize = 0;
    }

    // ang content ay sumasakop sa [currentDumpSize + markerBytes, currentDumpSize + markerBytes + contentBytes)
    const startByte = currentDumpSize + markerBytes;
    currentStream.write(block);
    currentDumpSize += blockBytes;
    const endByte = startByte + contentBytes;

    entries.push({
      filename: path.basename(relPath),
      filepath: relPath,
      fileVersion: hashContent(content),
      dumpFile: dumpFileName(dumpIndex),
      startByte,
      endByte,
    });
  }
  currentStream.end();

  const indexFile: IndexFile = { generatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(path.join(indexDirAbs, "index.json"), JSON.stringify(indexFile, null, 2), "utf-8");
  return indexFile;
}

/** Binabasa ang laman ng isang partikular na file mula sa dump, gamit ang byte offsets ng index.json. */
export function readFromIndex(filepath: string, cwd: string = process.cwd()): string | undefined {
  const indexPath = path.join(cwd, INDEX_DIR, "index.json");
  if (!fs.existsSync(indexPath)) return undefined;

  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as IndexFile;
  const entry = index.entries.find((e) => e.filepath === filepath);
  if (!entry) return undefined;

  const dumpPath = path.join(cwd, INDEX_DIR, entry.dumpFile);
  // Basahin bilang Buffer at hiwalayin gamit ang byte offsets para eksakto sa byte
  // ang pagbuo (gagamit ang String.slice ng UTF-16 code-unit indices at malilihis sa non-ASCII).
  const dump = fs.readFileSync(dumpPath);
  return dump.slice(entry.startByte, entry.endByte).toString("utf-8");
}

function dumpFileName(n: number): string {
  return `index${String(n).padStart(3, "0")}.dump`;
}

function hashContent(content: string): string {
  // magaan na content fingerprint, hindi cryptographic — sapat na para sa pagtuklas ng pagbabago
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return `v${(hash >>> 0).toString(16)}`;
}


