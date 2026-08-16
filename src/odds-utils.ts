export type ParsedAmericanMoneyline = {
  team: string;
  price: number;
  text: string;
};

export const MAX_TRUSTED_AMERICAN_MONEYLINE = 500;

export function parsePlausibleAmericanMoneyline(value: string): ParsedAmericanMoneyline | null {
  const match = String(value || "")
    .replace(/\u2212/g, "-")
    .trim()
    .match(/^([A-Z]{2,4})\s+([+-]\d{3,4})$/i);
  if (!match) return null;

  const team = match[1].toUpperCase();
  const price = Number(match[2]);
  const magnitude = Math.abs(price);
  if (!Number.isFinite(price) || magnitude < 100 || magnitude > MAX_TRUSTED_AMERICAN_MONEYLINE) {
    return null;
  }

  return { team, price, text: `${team} ${price > 0 ? "+" : ""}${price}` };
}
