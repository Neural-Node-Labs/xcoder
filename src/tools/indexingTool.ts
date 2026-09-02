import { buildIndex, readFromIndex } from "../indexing/indexer.js";
import { IndexFile } from "../core/types.js";

export interface IndexingResult {
  entriesCount: number;
  generatedAt: string;
  indexFile: IndexFile;
}

/**
 * Rebuild the workspace index (.agent/index/index.json + dump files).
 * Returns a summary of what was indexed.
 */
export async function rebuildIndex(cwd: string = process.cwd()): Promise<IndexingResult> {
  const indexFile = await buildIndex(cwd);
  return {
    entriesCount: indexFile.entries.length,
    generatedAt: indexFile.generatedAt,
    indexFile,
  };
}

/**
 * Read a specific file's content back from the index dump files.
 * Returns undefined if the file is not in the index.
 */
export function readIndexedFile(filepath: string, cwd: string = process.cwd()): string | undefined {
  return readFromIndex(filepath, cwd);
}


