const QRCode = require("qrcode");
const { FieldValue } = require("firebase-admin/firestore");
const paymentService = require("../server/payment-service");

const RATING_FIELDS = ["experience", "foodQuality", "cleanliness", "staffService"];

function configuredFeedbackUrl() {
  const configured = process.env.CANTEEN_FEEDBACK_URL || "";
  if (!configured) return null;
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw Object.assign(new Error("CANTEEN_FEEDBACK_URL must be a complete URL ending in #feedback."), { statusCode: 503 });
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.hash !== "#feedback" || url.username || url.password) {
    throw Object.assign(new Error("CANTEEN_FEEDBACK_URL must be an HTTPS URL ending in #feedback."), { statusCode: 503 });
  }
  return url.toString();
}

function validateFeedback(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("Submit a valid feedback form."), { statusCode: 400 });
  }
  const ratings = {};
  for (const field of RATING_FIELDS) {
    if (!Number.isInteger(body[field]) || body[field] < 1 || body[field] > 5) {
      throw Object.assign(new Error("Please provide a 1–5 star rating for every category."), { statusCode: 400 });
    }
    ratings[field] = body[field];
  }
  const comments = body.comments === undefined ? "" : body.comments;
  if (typeof comments !== "string" || comments.length > 1000) {
    throw Object.assign(new Error("Comments must be 1,000 characters or fewer."), { statusCode: 400 });
  }
  if (body.anonymous !== undefined && typeof body.anonymous !== "boolean") {
    throw Object.assign(new Error("The anonymous-feedback option is invalid."), { statusCode: 400 });
  }
  return { ...ratings, comments: comments.trim(), anonymous: body.anonymous === true };
}

module.exports = async function handler(req, res) {
  try {
    paymentService.requireSameOrigin(req);
    if (req.method === "GET") {
      const url = configuredFeedbackUrl();
      const submissionReady = paymentService.hasFirebaseServerConfiguration();
      const qrDataUrl = url
        ? await QRCode.toDataURL(url, { width: 360, margin: 2, errorCorrectionLevel: "M" })
        : null;
      return res.status(200).json({
        configured: Boolean(url),
        submissionReady,
        url,
        qrDataUrl,
        message: !url
          ? "Feedback QR is not configured. Set CANTEEN_FEEDBACK_URL to the full HTTPS app URL ending in #feedback."
          : !submissionReady
            ? "The feedback destination is set, but submissions need valid FIREBASE_SERVICE_ACCOUNT_JSON and FIREBASE_ADMIN_EMAIL server settings."
            : null
      });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed." });
    }
    const url = configuredFeedbackUrl();
    if (!url) {
      return res.status(503).json({ error: "Feedback is not configured. Nothing was saved; contact the canteen team." });
    }
    const feedback = validateFeedback(req.body);
    const { db } = paymentService.getFirebaseServices();
    const { FieldValue: firestoreFieldValue } = require("firebase-admin/firestore");
    await db.collection("canteenFeedback").add({
      ...feedback,
      createdAt: firestoreFieldValue.serverTimestamp()
    });
    return res.status(201).json({ saved: true });
  } catch (error) {
    console.error("Feedback request failed.", error);
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "The feedback service could not confirm receipt."
    });
  }
};
