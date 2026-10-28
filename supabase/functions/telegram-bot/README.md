# Telegram bot — ovozli xabardan vazifa

## Oqim
1. Saytda: Menyu → **Telegramni ulash** → bot ochiladi → Start (bir martalik kod, 10 daqiqa).
2. Botda loyiha tanlanadi (`/loyiha` bilan o'zgartiriladi).
3. Ovozli yoki matnli xabar → Whisper → GPT (nom, tavsif, mas'ul, muddat) → **✅ Yaratish / ❌ Bekor**.
4. Vazifa birinchi ochiq ustunga ("Rejada") `telegram` tegi bilan tushadi. Realtime va bildirishnomalar o'zi ishlaydi.

Buyruqlar: `/start`, `/loyiha`, `/uzish`. Faqat shaxsiy chatda ishlaydi.

## O'rnatish (bir marta)
1. **BotFather** → `/newbot` → token va username oling. Username'ni `public/config.js` → `telegramBot` ga yozing.
2. **SQL:** `supabase/sql/telegram_bot.sql` ni SQL Editor'da ishga tushiring.
3. **Secrets** (Dashboard → Edge Functions → Secrets):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` — tasodifiy uzun satr (`openssl rand -hex 32`)
   - `OPENAI_API_KEY`
   - ixtiyoriy: `STT_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY`, `PARSE_MODEL`, `SITE_URL`
4. **Deploy:** `supabase functions deploy telegram-bot --no-verify-jwt`
   (`--no-verify-jwt` shart: Telegram JWT yubormaydi; himoya — secret token header).
5. **Webhook:**
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d url=https://hpadmjyjcndxoiddoopq.supabase.co/functions/v1/telegram-bot \
     -d secret_token=<TELEGRAM_WEBHOOK_SECRET> \
     -d 'allowed_updates=["message","callback_query"]'
   ```

## Ma'lum cheklovlar
- Whisper o'zbekchada ism va atamalarda xato qiladi → tasdiqlash qadami shuning uchun bor. Sifat yetmasa: `STT_PROVIDER=elevenlabs`.
- `telegram_updates` jadvali o'sadi → keyinroq 7 kundan eskilarini cron bilan tozalash.
- Narx (taxminiy): Whisper $0.006/daqiqa + gpt-4o-mini har xabarga < $0.001.
