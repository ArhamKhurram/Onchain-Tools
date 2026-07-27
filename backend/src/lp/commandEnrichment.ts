export const LP_BLOCK_EXPLORER = 'https://robinhoodchain.blockscout.com';

export type LpCommandReceiptStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'reverted'
  | 'skipped';

export interface LpCommandCore {
  id: string;
  tokenId: string | null;
  poolAddress: string;
  action: string;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  requestedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  txHash: string | null;
  error: string | null;
}

export interface LpCommandView extends LpCommandCore {
  receiptStatus: LpCommandReceiptStatus;
  txExplorerUrl: string | null;
}

function isSkipped(error: string | null): boolean {
  return error !== null && error.trimStart().toLowerCase().startsWith('skipped');
}

function isReverted(command: LpCommandCore): boolean {
  return (
    command.status === 'failed' &&
    command.txHash !== null &&
    command.error !== null &&
    /reverted/i.test(command.error)
  );
}

export function deriveReceiptStatus(command: LpCommandCore): LpCommandReceiptStatus {
  switch (command.status) {
    case 'pending':
      return 'pending';
    case 'claimed':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      if (isSkipped(command.error)) return 'skipped';
      if (isReverted(command)) return 'reverted';
      return 'failed';
  }
}

export function txExplorerUrl(hash: string | null): string | null {
  return typeof hash === 'string' && hash.startsWith('0x') ? `${LP_BLOCK_EXPLORER}/tx/${hash}` : null;
}

export function enrichCommand(command: LpCommandCore): LpCommandView {
  return {
    ...command,
    receiptStatus: deriveReceiptStatus(command),
    txExplorerUrl: txExplorerUrl(command.txHash),
  };
}
