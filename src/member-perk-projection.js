/** What the owning client reads of their own perk snapshot. Staff read the whole record; a shop or rider reads none of it. */
export function clientPerk(perk) {
  if (!perk) return perk;
  const { useId: _use, organizationUserId: _organization, perkVersion: _version, ...visible } = perk;
  return visible;
}
/** The client's perk line beside the organization discount and the voucher. */
export const publicMemberPerk = money => money.memberPerkMinor > 0
  ? { memberPerkMinor: money.memberPerkMinor, memberPerk: clientPerk(money.memberPerk) } : {};
