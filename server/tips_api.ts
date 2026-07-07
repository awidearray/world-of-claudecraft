// REST handlers for player-economy TIPS (#923): a player tips another in a native
// token ($WOC/SOL). Thin HTTP boundary + BFF: validate untrusted input, resolve
// the recipient (by character name -> verified wallet), then delegate to the
// economy service through server/player_economy_proxy.ts. No SQL, no chain, and
// NO money math here: the service owns the amount, the memo, and the on-chain
// verification. This module only resolves the recipient wallet and passes
// through what the service returns. Mirrors jobs_api.ts's thin-handler shape.
import type http from 'node:http';
import { getCharacter, jobPartyByCharacterName, walletForAccount } from './db';
import { json, readBody } from './http_util';
import * as playerEconomyProxy from './player_economy_proxy';

// POST /api/player-economy/tip/quote -> the service pins the exact transfer +
// memo the sender must send. The client sends that exact transfer (with the
// memo), then calls tip/confirm.
export async function handleTipQuote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accountId: number,
): Promise<void> {
  if (!playerEconomyProxy.playerEconomyServiceConfigured())
    return json(res, 503, { error: 'tips are not available on this realm' });

  const body = await readBody(req);
  const characterId = Number(body.characterId);
  const recipientName = typeof body.recipientName === 'string' ? body.recipientName.trim() : '';
  const amountBase = typeof body.amountBase === 'string' ? body.amountBase.trim() : '';
  if (!Number.isFinite(characterId)) return json(res, 400, { error: 'invalid character' });
  if (!recipientName) return json(res, 400, { error: 'a recipient name is required' });
  if (!/^\d+$/.test(amountBase) || amountBase === '0')
    return json(res, 400, { error: 'a positive amount is required' });

  const character = await getCharacter(accountId, characterId);
  if (!character) return json(res, 404, { error: 'character not found' });
  const senderWallet = await walletForAccount(accountId);
  if (!senderWallet) return json(res, 400, { error: 'link a verified wallet before tipping' });

  const recipient = await jobPartyByCharacterName(recipientName);
  if (!recipient) return json(res, 404, { error: 'no player by that name has a verified wallet' });
  if (recipient.characterId === characterId)
    return json(res, 400, { error: 'you cannot tip yourself' });
  if (recipient.wallet === senderWallet.pubkey)
    return json(res, 400, { error: 'the recipient must use a different wallet' });

  // The service owns the amount + memo + destination; we pass the resolved
  // recipient wallet + amount through and echo the quote back verbatim.
  const quote = await playerEconomyProxy.tipQuote({
    fromAccountId: accountId,
    toAccountId: recipient.accountId,
    amountBase,
    toWallet: recipient.wallet,
  });
  if (!quote.ok) return json(res, 503, { error: quote.reason ?? 'tips are unavailable' });
  return json(res, 200, {
    ok: true,
    toAccountId: recipient.accountId,
    recipientName: recipient.name,
    memo: quote.memo,
    destination: quote.destination,
    mint: quote.mint,
    amountBase: quote.amountBase,
    expiresAtMs: quote.expiresAtMs,
  });
}

// POST /api/player-economy/tip/confirm -> the service verifies the settled
// transfer on-chain (finalized, exact amount, right recipient, matching memo)
// and records it once. Idempotent.
export async function handleTipConfirm(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accountId: number,
): Promise<void> {
  const body = await readBody(req);
  const toAccountId = Number(body.toAccountId);
  const amountBase = typeof body.amountBase === 'string' ? body.amountBase.trim() : '';
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const memo = typeof body.memo === 'string' ? body.memo.trim() : '';
  if (!Number.isFinite(toAccountId)) return json(res, 400, { error: 'invalid recipient' });
  if (!/^\d+$/.test(amountBase)) return json(res, 400, { error: 'invalid amount' });
  if (!signature) return json(res, 400, { error: 'a transaction signature is required' });
  if (!memo) return json(res, 400, { error: 'a tip memo is required' });

  const result = await playerEconomyProxy.tipConfirm({
    fromAccountId: accountId,
    toAccountId,
    amountBase,
    signature,
    memo,
  });
  return json(res, 200, {
    settled: result.settled,
    observedAmountBase: result.observedAmountBase,
    reason: result.reason,
  });
}
