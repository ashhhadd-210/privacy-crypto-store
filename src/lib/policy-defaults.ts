/**
 * Starting text for the three policy pages. The client edits them in the
 * admin; until they do, these show. The privacy text describes what the code
 * actually does, so it is accurate on day one. None of it is legal advice and
 * the admin page says so.
 */

export const POLICY_PAGES = {
  privacy: { path: '/privacy', title: 'Privacy' },
  terms: { path: '/terms', title: 'Terms of sale' },
  shipping: { path: '/shipping-returns', title: 'Shipping and returns' },
} as const;
export type PolicyKey = keyof typeof POLICY_PAGES;

export function defaultPolicy(key: PolicyKey, retentionDays: number): string {
  switch (key) {
    case 'privacy':
      return [
        'This store collects as little about you as it can, keeps it encrypted, and deletes it on a schedule.',
        'What we collect. To deliver an order we ask for your name, your delivery address and your email address. Nothing else: no phone number, no date of birth. You do not need an account to buy.',
        'How it is stored. Your name, address and email are encrypted before they are saved. The database, and any backup of it, holds no readable personal details.',
        `How long we keep it. ${retentionDays} days after an order is finished, its name, email and address are deleted automatically. We keep only an anonymous record of the sale (the date, the amount and the number of items).`,
        'Accounts. An account is optional and holds only your email address and a password, never your address. You can delete your account yourself at any time from your account page.',
        'Payment. You pay in Bitcoin through our own payment server. We do not receive or store any card or bank details. We never share your details with the payment server: it only knows an order number and an amount.',
        'No tracking. This site uses no analytics, no advertising and no tracking. It loads nothing from other websites. The only cookies are the ones needed for your cart and, if you sign in, your session.',
        'Emails. We email you only about your order: when it is received, when payment is confirmed, and when it ships. No newsletters and no tracking in the emails.',
        'Questions. Contact us using the details on this site.',
      ].join('\n\n');
    case 'terms':
      return [
        'These terms apply to orders placed on this store. [Store owner: replace this text with your own terms before launch.]',
        'Prices are shown in US dollars and paid in Bitcoin at the exchange rate shown on the payment page when you pay. An order is confirmed once payment is received in full.',
        'If a payment arrives after the payment window has closed, or for the wrong amount, we will contact you or refund it. Refunds are made in Bitcoin.',
        'We may cancel an order before it ships, for example if an item is unavailable, and will refund any payment received.',
      ].join('\n\n');
    case 'shipping':
      return [
        'Shipping and returns. [Store owner: replace this text with your own shipping regions, delivery times and return policy before launch.]',
        'Orders are prepared once payment is confirmed. You receive an email with a tracking number when your order ships.',
        'If something is wrong with your order, contact us with your order number.',
      ].join('\n\n');
  }
}
