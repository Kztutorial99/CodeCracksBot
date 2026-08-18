# Deploy ke Vercel (via GitHub)

1. Di Lovable: klik **GitHub → Connect / Push to GitHub** supaya kode masuk ke repo Anda.
2. Di Vercel: **Add New → Project → Import Git Repository** lalu pilih repo tersebut.
   - Framework Preset: **Other** (sudah diatur lewat `vercel.json`)
   - Build Command: `npm run build`
   - Output: otomatis (`.vercel/output`, dibuat oleh preset Vercel di `vite.config.ts`)
3. Tambahkan Environment Variables di Vercel (Settings → Environment Variables), untuk Production & Preview:

| Name | Nilai |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token bot dari @BotFather (`123456:AA...`) |
| `QWEN_API_KEY` | API key QwenCloud (`sk-...`) |
| `QWEN_MODEL` | opsional, default `qwen3.8-max` |
| `QWEN_BASE_URL` | opsional, kalau pakai endpoint region lain |
| `TELEGRAM_WEBHOOK_SECRET` | string acak buatan Anda, mis. hasil `openssl rand -hex 32` |

4. Deploy, lalu daftarkan webhook ke domain Vercel Anda (jalankan sekali dari terminal):

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://NAMA-PROYEK.vercel.app/api/public/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d "allowed_updates=[\"message\"]"
```

Cek status: `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"`

Catatan: kalau `TELEGRAM_BOT_TOKEN` diisi, aplikasi memanggil Telegram API langsung
(tanpa gateway Lovable), jadi deploy di Vercel jalan mandiri.
