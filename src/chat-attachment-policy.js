// Kept dependency-free: attachment authorization and order projections import
// each other through existing chat modules.
export const CLIENT_SHOP_CHAT_PURPOSE = 'client_shop_chat_attachment';
export const CLIENT_SHOP_CHAT_MAX_BYTES = 10 * 1024 * 1024;
export const CLIENT_SHOP_CHAT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
