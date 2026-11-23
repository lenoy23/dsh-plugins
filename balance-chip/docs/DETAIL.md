# Account balance

Shows the signed-in account balance at the sidebar foot, beside the account
launcher.

## What it does

- Reads the wallet balance through the account Remote (`account.getBalance`), the
  same source the account settings page uses.
- Renders the funded wallet amount with its currency symbol (`¥` or `$`), two
  decimals, and tabular digits.
- Refreshes every 30 seconds, and immediately when the account UI refreshes or the
  stored credential changes.
- Hides itself while signed out and in the collapsed sidebar rail, and shows `—`
  when the balance request fails.

## Limitations

- Only one wallet is shown; the funded one wins, and bonus wallets stay separate.
- A failed request does not retry faster than the regular interval.
