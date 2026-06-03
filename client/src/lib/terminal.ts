export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export function isValidTerminalDimensions(value: unknown): value is TerminalDimensions {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const dimensions = value as { cols?: unknown; rows?: unknown };
  return (
    Number.isInteger(dimensions.cols) &&
    Number(dimensions.cols) > 0 &&
    Number(dimensions.cols) <= 500 &&
    Number.isInteger(dimensions.rows) &&
    Number(dimensions.rows) > 0 &&
    Number(dimensions.rows) <= 500
  );
}
