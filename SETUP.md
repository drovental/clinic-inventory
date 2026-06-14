# מדריך פריסה — מערכת מלאי קליניקה
## זמן הקמה משוער: 25-30 דקות

---

## שלב 1 — הכן Firebase (10 דקות)

### 1.1 צור פרויקט Firebase
1. לך ל-https://console.firebase.google.com
2. לחץ **"Add project"**
3. שם הפרויקט: `clinic-inventory` (או כל שם שתרצה)
4. Google Analytics — אפשר לבטל, לא נחוץ
5. לחץ **"Create project"**

### 1.2 הוסף אפליקציית Web
1. בעמוד הפרויקט, לחץ על אייקון `</>`  (Web)
2. שם האפליקציה: `clinic-app`
3. **אל תסמן** Firebase Hosting (נשתמש ב-Vercel)
4. לחץ **"Register app"**
5. **העתק את האובייקט firebaseConfig** — תצטרך אותו בצעד 3

### 1.3 הפעל Authentication
1. בסיידבר: **Build → Authentication → Get started**
2. לחץ **"Email/Password"** → Enable → Save
3. לך ל-**Users → Add user**
4. הוסף אימייל וסיסמה לכל מטפל בקליניקה

### 1.4 צור Firestore Database
1. בסיידבר: **Build → Firestore Database → Create database**
2. בחר **"Start in production mode"**
3. Region: `europe-west1` (קרוב לישראל)
4. לחץ Create

### 1.5 הגדר חוקי אבטחה
1. ב-Firestore → לשונית **Rules**
2. מחק את הכל והדבק את תוכן קובץ `firestore.rules`
3. לחץ **Publish**

---

## שלב 2 — הכן את הקוד (5 דקות)

```bash
# פתח טרמינל בתיקיית הפרויקט
cd clinic-inventory

# התקן תלויות
npm install
```

---

## שלב 3 — הוסף את מפתחות Firebase (2 דקות)

פתח את הקובץ `src/firebase.js` והחלף את הערכים:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",           // מה שהעתקת מהקונסול
  authDomain: "clinic-xxx.firebaseapp.com",
  projectId: "clinic-xxx",
  storageBucket: "clinic-xxx.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
```

---

## שלב 4 — בדוק מקומית (2 דקות)

```bash
npm start
```

פתח http://localhost:3000 — התחבר עם אחד מהמשתמשים שהוספת.

---

## שלב 5 — פרוס לענן עם Vercel (5 דקות)

Vercel היא הדרך הכי פשוטה — hosting בחינם, HTTPS אוטומטי, CDN גלובלי.

### אפשרות א': דרך GitHub (מומלץ)
1. העלה את הפרויקט ל-GitHub (repo חדש, פרטי)
2. לך ל-https://vercel.com → התחבר עם GitHub
3. לחץ **"New Project"** → בחר את ה-repo
4. הגדרות:
   - Framework: **Create React App**
   - Build Command: `npm run build`
   - Output Directory: `build`
5. לחץ **Deploy**

### אפשרות ב': דרך CLI
```bash
npm install -g vercel
npm run build
vercel --prod
```

### לאחר הפריסה
Vercel ייתן לך URL כמו `https://clinic-inventory-xxx.vercel.app`

**זה הקישור שתשלח לכל המטפלים!**

---

## שלב 6 — התקנה כ-PWA על הטלפון (1 דקה)

### אנדרואיד (Chrome):
1. פתח את הקישור ב-Chrome
2. לחץ על 3 הנקודות ← **"הוסף למסך הבית"**
3. האפליקציה מופיעה כאייקון עצמאי

### אייפון (Safari):
1. פתח ב-Safari
2. לחץ **Share** (ריבוע עם חץ) ← **"Add to Home Screen"**

---

## שלב 7 — הוסף מלאי ראשוני

1. היכנס לאפליקציה
2. לך לטאב **מלאי** ← **הוסף פריט חדש**
3. הזן לכל מוצר: שם, ברקוד (מהאריזה), יצרן, כמות, תפוגה, סף הזמנה

**טיפ:** הדפס ברקוד EAN-13 או Code128 על מדבקות עם כלי חינמי כמו https://barcode.tec-it.com

---

## ניהול משתמשים

כל הוספה/הסרה של מטפל נעשית ב:
**Firebase Console → Authentication → Users**

אין צורך לנגע בקוד!

---

## עלויות Firebase (Spark Plan — חינם)

| מה | מגבלה בחינם | צפוי בקליניקה |
|---|---|---|
| Firestore reads | 50,000/יום | ~500/יום ✅ |
| Firestore writes | 20,000/יום | ~100/יום ✅ |
| Auth users | ללא הגבלה | 3-5 ✅ |
| Storage | 1GB | כמעט לא בשימוש ✅ |

**עלות: $0/חודש**

---

## תמיכה ושאלות

בעיות נפוצות:
- **"Permission denied"** → בדוק שחוקי Firestore הוגדרו נכון (שלב 1.5)
- **מצלמה לא עובדת** → חייב HTTPS. בפיתוח מקומי תעבוד רק על localhost
- **ברקוד לא מזוהה** → ודא שהברקוד במלאי זהה בדיוק לברקוד על האריזה
