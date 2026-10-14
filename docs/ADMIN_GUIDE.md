# Your store: the admin guide

Everything you do day to day happens at `https://<your domain>/admin`. Sign in with your email
and password. After five wrong attempts the sign-in locks for fifteen minutes, which keeps
automated guessing out; if it happens to you, wait and try again.

**First thing to do:** Overview → *Change password*. Choose a passphrase of four or five
ordinary words. Keep it in your password manager.

## Overview

What needs you today: orders to ship, orders waiting for payment, sales over the last 30 days,
payments for the wrong amount, and products running low. Click any card to go straight there.

**Store setup** shows what is switched on: store name, products, shipping price, Bitcoin payments,
order emails and encrypted backups. Anything without a green tick still needs doing.

**View shop** (top right) opens your store in a new tab. The moon/sun button switches the admin
and shop between light and dark for you.

## Orders

1. **Orders → To ship** lists everything that has been paid.
2. Open an order to see the delivery address. Each time you open one, it is recorded, so you
   always know who has seen a customer's address.
3. Post it, type the tracking number, press **Mark shipped**. The customer gets an email with the
   tracking number.
4. When you know it has arrived, press **Mark as delivered**. If you don't, the store does it for
   you a set number of days after shipping (Settings). Either way the order is then complete, and
   the deletion clock for its customer details starts from that moment.

Other things you can do on an order:
- **Cancel** an order that has not been paid. Its payment page stops working.
- **Reopen for payment** if a customer missed the payment window and wants to pay.
- **Mark as refunded** once you have sent the Bitcoin back from your own wallet, including for an
  order that was shipped and returned.
- **Resend the latest email** if a customer says it never arrived.
- **Staff note**: only you see it. Do not put customer details in it; notes are kept after the
  order's personal details are deleted.

**Payments for the wrong amount.** Bitcoin payments are sometimes a little under or over. The
order shows "Paid too little" or "Paid too much". Contact the customer, or refund the
difference, then carry on as normal.

## Products

- **Add a product**: name, description (leave a blank line between paragraphs), price, stock.
  New products start **hidden**. Tick *Visible in the shop* when it is ready.
- **Photos**: upload JPEG, PNG or WebP up to 10 MB. Before a photo is saved, the hidden details
  phones add are removed, including the GPS location where it was taken. The first photo is the
  main one; *Make main* changes that.
- **Count stock**: untick it for made-to-order items. They never sell out.
- There is no delete. Untick *Visible in the shop* instead; old orders still show what was bought.
- **Bulk prices** (optional, on each product): up to three rows of "buy at least N, pay X each".
  Example: 10 or more at $20, 25 or more at $18. Larger quantities must cost less each. The
  product page shows them under the price, and the cart applies them automatically.
- Customers choose a quantity on the product page, up to 99 per product (or your stock, if
  lower).

## Discount codes

Create a code, choose a percentage or a fixed amount, and optionally a minimum spend, a limit on
uses, and first and last days. Untick *Switched on* to stop a code immediately. A use is counted
only when an order is paid.

**Discounts by order total** are in Settings: up to three rows of "orders of at least $A get
P% off", for example $500 → 10% and $1000 → 20%. They are worked out on the items after bulk
prices, the highest one reached applies (not both), and a discount code still works on top of
what is left. The cart tells customers how much more they need for the next discount.

## Pages

Your Privacy, Terms and Shipping pages, linked at the bottom of every page. The Privacy page
already describes exactly what the store does with customer data. **Before launch, read all
three and replace anything in [square brackets]** with your own terms, shipping regions and
return policy. This text is a starting point, not legal advice.

## Settings

- **Store name**, **flat shipping** (0 for free shipping) and **free shipping on orders over** an
  amount (empty for never).
- **Discounts by order total**: see Discount codes above.
- **Keep customer details for N days.** After that, finished orders lose their name, email and
  address automatically every night. For a delivered order the days count from delivery, so you
  keep the address through any return.
- **Count shipped orders as delivered after N days** (14 to start). Stops a shipped order from
  keeping its customer's details for ever if you forget to mark it delivered.
- **Only delete orders that have been exported.** While this is ticked, an order's details are
  only deleted after it has been in one of your encrypted exports. Download an export regularly,
  or untick it if you don't want offline copies. Your sales totals are kept. Orders still being paid for or
  delivered are never touched, however old.
- **Run the deletion now** if you want it done immediately. The history underneath shows every
  run.

## Export (your records, offline)

**Export → Download encrypted export** gives you one file with every order the store still holds,
including names and addresses, locked to your own key. Keep it somewhere offline. To open it on
your computer: `age -d -i your-key.txt store-export-….json.age > orders.json`.

Your key is a small text file that starts `AGE-SECRET-KEY-1`. **Keep it in your password manager
and nowhere else.** Without it, neither you nor anyone else can open your exports or backups;
that is the point. The store only ever holds the matching public key, so it can lock files but
never open them.

## What happens automatically

| Every | What |
|---|---|
| 5 minutes | Any payment the store missed is picked up; waiting emails are sent |
| Night, 02:45 UTC | An encrypted backup of the store, kept for your retention period |
| Night, 03:30 UTC | Customer details older than your retention period are deleted |
| Night | Security updates install on the server |

## Who to call

Your developer has the technical runbook. For anything that looks wrong (a payment that did not
arrive, an email that did not send, the site down), note the order number and the time, and get
in touch.
