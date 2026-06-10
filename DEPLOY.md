# Fuel board — bulutga joylash (Render, 24/7, login bilan)

Maqsad: serverni internetda 24/7 ishlatib, ishxonadan ham login/parol bilan kirish.
Uy kompi o'chiq bo'lsa ham ishlaydi.

---

## Kerakli narsalar
- Bepul **GitHub** account (kod uchun): https://github.com
- Bepul **Render** account (server uchun): https://render.com

Ikkalasini ham bepul ochish mumkin.

---

## 1-bosqich — kodni GitHub'ga yuklash

1. https://github.com ga kiring (yoki ro'yxatdan o'ting).
2. O'ng yuqoridagi **+** → **New repository**.
3. Repository name: `fuel-board`. **Private** ni tanlang (maxfiy). **Create repository**.
4. Keyingi sahifada ko'rsatilgan komandalarni ishlatamiz (men yordam beraman), yoki
   **"uploading an existing file"** havolasi orqali papka fayllarini drag-drop qilasiz.

> Eslatma: `.env` va `fuel_cache.json` GitHub'ga YUBORILMAYDI (`.gitignore` da). API kalit maxfiy qoladi.

---

## 2-bosqich — Render'da server yaratish

1. https://render.com ga GitHub bilan kiring.
2. **New +** → **Web Service**.
3. `fuel-board` repo'sini tanlang (Render uni `render.yaml` orqali o'qiydi).
4. **Environment variables** bo'limida 3 ta qiymat kiriting:

   | Key | Value |
   |-----|-------|
   | `MOTIVE_API_KEY` | (sizning Motive kalitingiz) |
   | `AUTH_USER` | `admin` (yoki xohlagan login) |
   | `AUTH_PASS` | (kuchli parol — buni eslab qoling) |

5. **Plan: Free**. **Create Web Service** ni bosing.
6. 1-2 daqiqada server tayyor bo'ladi. Render sizga URL beradi, masalan:
   `https://fuel-board-xxxx.onrender.com`

---

## 3-bosqich — ishxonadan kirish

- Ishxona kompida brauzerda Render bergan URL'ni oching.
- Brauzer login/parol so'raydi → `AUTH_USER` va `AUTH_PASS` ni kiriting.
- Tamom — flot fuel board ochiladi.

---

## Muhim eslatmalar

- **Bepul plan** 15 daqiqa ishlatilmasa "uxlaydi"; keyingi ochishda ~50 soniya kechikadi
  (cold start). Doim tez bo'lishi uchun pullik plan ($7/oy) kerak.
- Bepul planda server uxlaganda **last-known fuel kesh** tozalanadi va trucklar
  yana yurganda to'ladi. Kesh doim saqlanishi uchun pullik "Persistent Disk" kerak.
- Parolni o'zgartirish: Render → Environment → `AUTH_PASS` ni yangilang → Save (qayta deploy bo'ladi).
- Kod yangilansa va GitHub'ga push qilinsa, Render avtomatik qayta deploy qiladi.
