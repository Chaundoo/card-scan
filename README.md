# Chaundoo Card Scan

Brother site to [Chaundoo Card Flipz](https://chaundoo.github.io/card-flipz/). Live at https://chaundoo.github.io/card-scan/

- **Scan:** snap a card. The site reads the number, set total or set code, and name on your phone (Tesseract.js), then lists matching cards with pictures. English and Japanese.
- **Card:** pick the printing and condition. You get TCGplayer, eBay last sold, eBay listings and PriceCharting links, plus quick TCGplayer prices.
- **Live comps:** with the helper userscript (`chaundoo-scan-helper.user.js`), **Open & read** opens each page in a new tab, reads the sales and listings shown there, and sends them back. No helper? Use **Paste**.
- **Math:** comp value for your condition, vendor and eBay exits, walk-away max, opening offer, and a buy/negotiate/pass call on the sticker price. Lag flag when recent sales run ahead of the median.

Card catalog and pictures come from the free [TCGdex API](https://tcgdex.dev). Nothing here saves prices; live data lives in the open tab only.
