// OFAC SDN wallet screening (launchpad phase 8, PRD section 10). The SDN list
// publishes sanctioned digital-currency addresses inline in the entry remarks
// ("Digital Currency Address - XBT 1Abc...;"); this module loads the flat SDN
// file, extracts every such address across all asset tags (a Solana address
// is matched by exact string), and screens each linked wallet a launchpad
// money route touches.
//
// FAIL-CLOSED SEMANTICS: while screening is enabled, a wallet-touching money
// operation is refused when the list has never loaded (SanctionsUnavailableError
// -> 503 sanctions_unavailable) and, of course, when the wallet is listed
// (SanctionedWalletError -> 451 wallet_sanctioned). A failed REFRESH keeps the
// previous list: a stale list still screens, while flapping to closed on every
// transient fetch error would turn OFAC's uptime into ours.

export function sdnScreenEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REALM_OFAC_SCREEN_ENABLED ?? '').trim() === '1';
}

// The canonical OFAC flat file. The remarks column carries the digital
// currency addresses this module screens against.
export const DEFAULT_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';

export function sdnListUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.REALM_OFAC_SDN_URL ?? '').trim();
  return raw !== '' ? raw : DEFAULT_SDN_URL;
}

// "Digital Currency Address - <TAG> <address>" as it appears in SDN remarks
// (CSV and XML renderings both). The address charset is base58-ish across
// chains; exact-string membership is what screening needs, so every tag's
// addresses are kept in one set.
const SDN_ADDRESS =
  /Digital Currency Address\s*-\s*[0-9A-Za-z]{2,10}\s+([1-9A-HJ-NP-Za-km-z]{25,64})/g;

export function parseSdnDigitalCurrencyAddresses(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(SDN_ADDRESS)) out.add(match[1]);
  return out;
}

export class SanctionedWalletError extends Error {
  constructor(address: string) {
    super(`wallet is on the OFAC SDN list: ${address}`);
  }
}

export class SanctionsUnavailableError extends Error {
  constructor() {
    super('OFAC SDN screening is enabled but the list is not loaded');
  }
}

// The seam money routes screen through. `null` screen = screening disabled.
export interface SanctionsScreen {
  // Throws SanctionsUnavailableError / SanctionedWalletError; returns on clear.
  assertClear(address: string): void;
}

export class SdnList implements SanctionsScreen {
  private addresses: Set<string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fetchText: () => Promise<string>,
    private readonly refreshMs = 24 * 60 * 60 * 1000,
  ) {}

  loaded(): boolean {
    return this.addresses !== null;
  }

  size(): number {
    return this.addresses?.size ?? 0;
  }

  async load(): Promise<number> {
    const parsed = parseSdnDigitalCurrencyAddresses(await this.fetchText());
    this.addresses = parsed;
    return parsed.size;
  }

  // Initial load plus the daily refresh. A failed load is EXPECTED transient
  // IO (the list host is not ours): log and keep whatever list we had; the
  // fail-closed guard in assertClear covers the never-loaded case.
  start(log: (msg: string) => void = console.error): void {
    const attempt = () =>
      this.load()
        .then((n) => log(`OFAC SDN list loaded: ${n} digital currency addresses`))
        .catch((err) => log(`OFAC SDN list load failed: ${err}`));
    void attempt();
    this.timer = setInterval(attempt, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  assertClear(address: string): void {
    if (this.addresses === null) throw new SanctionsUnavailableError();
    if (this.addresses.has(address)) throw new SanctionedWalletError(address);
  }
}
