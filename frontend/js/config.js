/* Where is the backend?
   "" (empty) means "the same address that serves this page". That is the case
   when Docker serves both folders, which is how the project runs locally.
   If you host the frontend on its own (Netlify, Vercel, GitHub Pages, ...),
   put the public backend URL here, for example:
   window.OBF_CONFIG = { apiBaseUrl: "https://openbatteryflux-api.onrender.com" };
*/
window.OBF_CONFIG = { apiBaseUrl: "" };
