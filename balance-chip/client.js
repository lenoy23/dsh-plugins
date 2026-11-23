window.__ModuleLoader__.load({
  id: '@local/balance-chip',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'account.balance';
    const DICT = {
      en: {
        title: 'Account balance',
        label: 'Balance',
        pending: 'Reading the balance…',
        toRub: 'Click to show in rubles',
        toCny: 'Click to show in the original currency',
        noRate: 'Exchange rate is unavailable',
      },
      ru: {
        title: 'Баланс аккаунта',
        label: 'Баланс',
        pending: 'Читаю баланс…',
        toRub: 'Клик — показать в рублях',
        toCny: 'Клик — показать в исходной валюте',
        noRate: 'Курс недоступен',
      },
    };
    const DISPLAY_KEY = 'balance-chip:display';
    const RATE_KEY = 'balance-chip:rate';
    const RATE_TTL_MS = 60 * 60 * 1000;
    const RATE_URL = 'https://open.er-api.com/v6/latest/CNY';
    /** CNY balance below which the chip turns red and warns about a top-up. */
    const LOW_BALANCE_CNY = 1;

    /** @returns the persisted display currency, defaulting to the wallet currency. */
    function readDisplay() {
      try {
        return localStorage.getItem(DISPLAY_KEY) === 'RUB' ? 'RUB' : 'ORIGINAL';
      } catch (error) {
        return 'ORIGINAL';
      }
    }

    /** @param value - display currency to persist. */
    function writeDisplay(value) {
      try {
        localStorage.setItem(DISPLAY_KEY, value);
      } catch (error) {
        // Private storage keeps the in-memory choice for this page only.
      }
    }

    /** @returns a cached CNY rate snapshot younger than an hour, or null. */
    function readCachedRate() {
      try {
        const raw = localStorage.getItem(RATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.rub !== 'number' || typeof parsed.usd !== 'number') return null;
        if (!(Date.now() - parsed.at < RATE_TTL_MS)) return null;
        return parsed;
      } catch (error) {
        return null;
      }
    }

    /** @returns a CNY-based rate snapshot, fetching and caching it when stale. */
    async function readRate() {
      const cached = readCachedRate();
      if (cached) return cached;
      const response = await fetch(RATE_URL);
      if (!response.ok) throw new Error('rate request failed');
      const payload = await response.json();
      const rates = payload && payload.rates;
      if (!rates || typeof rates.RUB !== 'number' || typeof rates.USD !== 'number') throw new Error('rate missing');
      const snapshot = { rub: rates.RUB, usd: rates.USD, at: Date.now() };
      try {
        localStorage.setItem(RATE_KEY, JSON.stringify(snapshot));
      } catch (error) {
        // The snapshot stays usable for this render.
      }
      return snapshot;
    }

    /** @param currency - wallet currency code. @returns the wallet symbol. */
    function symbolOf(currency) {
      return currency === 'USD' ? '$' : '¥';
    }

    /** @param state - chip state. @returns the amount text for the active display currency. */
    function amountText(state) {
      if (state.amount === null) return null;
      const original = symbolOf(state.currency) + state.amount.toFixed(2);
      if (state.display !== 'RUB') return original;
      if (!state.rate) return '₽…';
      const rub = state.currency === 'USD'
        ? state.amount * (state.rate.rub / state.rate.usd)
        : state.amount * state.rate.rub;
      return '₽' + rub.toFixed(2);
    }

    /** @param state - chip state. @returns both amounts for the tooltip. */
    function tooltipText(state) {
      if (state.amount === null) return null;
      const original = symbolOf(state.currency) + state.amount.toFixed(2);
      if (!state.rate) return original;
      const rub = state.currency === 'USD'
        ? state.amount * (state.rate.rub / state.rate.usd)
        : state.amount * state.rate.rub;
      return original + ' · ₽' + rub.toFixed(2);
    }

    /** Balance chip rendered at the sidebar foot; a click switches the display currency. */
    function BalanceChip(props) {
      const t = props.t;
      const wide = props.wide !== false;
      const state = props.useBalance(value => value);
      if (!state || state.hidden || !wide) return null;

      const text = amountText(state);
      const both = tooltipText(state);
      const hint = state.display === 'RUB' ? t('toCny') : t('toRub');
      const missingRate = state.display === 'RUB' && !state.rate;
      const low = state.currency === 'CNY' && state.amount !== null && state.amount < LOW_BALANCE_CNY;
      const title = (text ? t('title') + ': ' + both : t('pending')) + ' — ' + (missingRate ? t('noRate') : hint);

      return h('button', {
        type: 'button',
        title,
        'aria-label': t('title'),
        onClick: () => { props.toggle(); },
        style: {
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: '6px',
          height: '30px',
          padding: '0 8px',
          margin: '0',
          border: 'none',
          background: 'transparent',
          borderRadius: '6px',
          cursor: 'pointer',
          font: 'inherit',
          lineHeight: '1',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        },
      },
      h('span', {
        style: {
          fontSize: '12px',
          fontWeight: '500',
          color: low ? 'var(--dsw-alias-label-danger, #f05252)' : 'var(--dsw-alias-label-secondary)',
        },
      }, t('label')),
      h('span', {
        style: {
          fontSize: '14px',
          fontWeight: '650',
          letterSpacing: '0.01em',
          color: low ? 'var(--dsw-alias-label-danger, #f05252)' : 'var(--dsw-alias-label-primary)',
        },
      }, text || '—'));
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account', 'accountUi'],
      apply(ctx) {
        let state = { hidden: true, amount: null, currency: 'CNY', display: readDisplay(), rate: null };
        const listeners = new Set();
        const publish = (next) => {
          state = next;
          for (const listener of listeners) listener();
        };
        const store = {
          getSnapshot: () => state,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
          },
        };

        /** @returns whether the host reports a stored account credential. */
        const signedIn = () => {
          try {
            const snapshot = ctx.accountUi.getSnapshot();
            return Boolean(snapshot && snapshot.view && snapshot.view.status === 'credential-stored' && !snapshot.failed);
          } catch (error) {
            return false;
          }
        };

        /** @param wallets - recharge and bonus wallets. @returns the funded wallet, or the first one. */
        const pickWallet = (wallets) => {
          let first = null;
          for (const wallet of wallets) {
            if (!wallet || typeof wallet.balance !== 'string') continue;
            const amount = Number(wallet.balance);
            if (!Number.isFinite(amount)) continue;
            const entry = { amount, currency: wallet.currency === 'USD' ? 'USD' : 'CNY' };
            if (amount > 0) return entry;
            if (first === null) first = entry;
          }
          return first;
        };

        /** Re-read the exchange rate when the ruble display needs one. */
        const ensureRate = async () => {
          if (state.display !== 'RUB' || state.rate) return state.rate;
          try {
            const rate = await readRate();
            state = { ...state, rate };
            for (const listener of listeners) listener();
            return rate;
          } catch (error) {
            return null;
          }
        };

        const applyWallets = (wallets) => {
          const wallet = pickWallet(wallets || []);
          publish({
            hidden: false,
            amount: wallet ? wallet.amount : null,
            currency: wallet ? wallet.currency : 'CNY',
            display: state.display,
            rate: state.rate,
          });
          void ensureRate();
        };

        /** Reuse the account UI's own balance projection without another request. */
        const publishFromSnapshot = () => {
          if (!signedIn()) {
            publish({ hidden: true, amount: null, currency: 'CNY', display: state.display, rate: state.rate });
            return;
          }
          let balance;
          try {
            const snapshot = ctx.accountUi.getSnapshot();
            balance = snapshot && snapshot.details && snapshot.details.balance;
          } catch (error) {
            balance = undefined;
          }
          if (!balance) return;
          if (balance.status !== 'ready') {
            publish({ hidden: false, amount: null, currency: 'CNY', display: state.display, rate: state.rate });
            return;
          }
          applyWallets((balance.value || []).concat(balance.bonusWallets || []));
        };

        /** Read the balance through the account Remote. */
        const refresh = async () => {
          if (!signedIn()) {
            publish({ hidden: true, amount: null, currency: 'CNY', display: state.display, rate: state.rate });
            return;
          }
          try {
            const metadata = ctx.accountUi.clientMetadata(ctx.locale.getSnapshot().active);
            const result = await ctx.remote.account.getBalance(metadata);
            if (!result || !result.ok || !result.value || result.value.status !== 'ready') {
              publish({ hidden: false, amount: null, currency: 'CNY', display: state.display, rate: state.rate });
              return;
            }
            const value = result.value;
            applyWallets((value.value || []).concat(value.bonusWallets || []));
          } catch (error) {
            publish({ hidden: false, amount: null, currency: 'CNY', display: state.display, rate: state.rate });
          }
        };

        /** @param next - display currency demanded by the chip. */
        const setDisplay = (next) => {
          writeDisplay(next);
          publish({ ...state, display: next });
          void ensureRate();
        };

        ctx.effect(() => ctx.locale.register(NS, DICT), 'balance: dictionaries');
        ctx.effect(() => {
          publishFromSnapshot();
          void refresh();
          void ensureRate();
          const timer = setInterval(() => { void refresh(); }, 30000);
          return () => { clearInterval(timer); };
        }, 'balance: refresh loop');
        ctx.on('account-ui/change', () => { publishFromSnapshot(); void refresh(); });
        ctx.on('account-ui/refresh', () => { void refresh(); });

        const register = () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'account-balance',
          order: 0,
          locale: NS,
          inject: () => ({
            hooks: { balance: store },
            toggle: () => { setDisplay(state.display === 'RUB' ? 'ORIGINAL' : 'RUB'); },
          }),
        }, BalanceChip));

        let remoteAccess;
        try {
          remoteAccess = typeof ctx.get === 'function' ? ctx.get('remoteAccess') : undefined;
        } catch (error) {
          remoteAccess = undefined;
        }
        if (remoteAccess && typeof remoteAccess.whenAccess === 'function') {
          remoteAccess.whenAccess('account/watch', register);
        } else {
          register();
        }
      },
    };
  },
});


