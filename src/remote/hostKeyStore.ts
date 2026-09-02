import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Trust-on-first-use (TOFU) na pag-verify ng host key para sa ssh2 password-auth na koneksyon.
 *
 * Dati, ang sshTool.ts at sshConnection.ts ay parehong nagpapasa ng `hostVerifier: () => true`
 * o ganap na inaalis ang host verification — ibig sabihin ay tinatanggap ng ssh2 ang *anumang*
 * host key para sa *anumang* host, nang tahimik. Iniiwan nito ang mga password-auth na SSH
 * connection na bukas sa man-in-the-middle: isang umaatake na nakaupo sa pagitan ng devnull at
 * ng target host ay maaaring magpakita ng sarili nilang key at hindi mapapansin ng magkabilang
 * panig.
 *
 * Ginagaya nito ang behavior na mayroon na ang key-based (shell-out `ssh`/`scp`) na landas sa
 * pamamagitan ng `-o StrictHostKeyChecking=accept-new`: sa unang pagkakataong kumonekta kami sa
 * isang partikular na host:port, itinatala namin ang fingerprint ng key nito; dapat tumugma ang
 * bawat kasunod na koneksyon, o tatanggihan namin ang pagkonekta. Ang isang nagbagong fingerprint
 * ay halos palaging nangangahulugan na alinman ay lehitimong na-rebuild/na-rekey ang server
 * (kung kaya't burahin ang lumang entry) o may humahadlang sa koneksyon.
 */

const STORE_DIR = path.join(os.homedir(), ".devnull");
const STORE_PATH = path.join(STORE_DIR, "known_hosts.json");

interface KnownHostsFile {
  [hostPort: string]: string; // sha256 hex fingerprint
}

function readStore(): KnownHostsFile {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as KnownHostsFile;
  } catch {
    return {};
  }
}

function writeStore(store: KnownHostsFile): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch {
    // Best-effort na pag-persist — kung hindi namin maisulat ang store, tatakbo pa rin ang
    // verification para sa koneksyong ito gamit ang anumang na-load, hindi lamang nito
    // maaalala ang mga bagong host sa mga susunod na pagpapatakbo.
  }
}

export type HostKeyVerifyResult = { accepted: boolean; reason: string };

/**
 * TOFU-verify ang fingerprint ng key ng isang host (na-hash na ng ssh2 bilang hex, dahil
 * dapat magpasa ang mga caller ng `hostHash: "sha256"` sa kanilang ssh2 Client.connect() na
 * tawag para makatanggap ito ng hex digest sa halip na ang raw key). Nagtatala ng mga
 * unang-nakitang fingerprint; tinatanggihan ang mga hindi tugma.
 */
export function verifyHostKeyTofu(host: string, port: number, fingerprintHex: string): HostKeyVerifyResult {
  const key = `${host}:${port}`;
  const store = readStore();
  const known = store[key];

  if (!known) {
    store[key] = fingerprintHex;
    writeStore(store);
    return { accepted: true, reason: `First connection to ${key} — fingerprint recorded.` };
  }

  if (known === fingerprintHex) {
    return { accepted: true, reason: "Fingerprint matches known host." };
  }

  return {
    accepted: false,
    reason:
      `REFUSED: host key for ${key} does not match the previously recorded fingerprint. ` +
      `This could mean the server was rebuilt/rekeyed, OR that the connection is being intercepted. ` +
      `If you trust this change, remove the "${key}" entry from ${STORE_PATH} and reconnect.`,
  };
}
