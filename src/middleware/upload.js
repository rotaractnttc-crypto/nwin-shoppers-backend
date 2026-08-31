const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { configured: cloudinaryConfigured } = require("../config/cloudinary");

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 5);
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function fileFilter(_req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only JPEG, PNG, or WEBP images are allowed."));
  }
  cb(null, true);
}

// Cloudinary path: keep the file in memory, upload the buffer directly —
// nothing ever touches this server's disk, so it survives redeploys.
const memoryStorage = multer.memoryStorage();

// Local-dev fallback only (no Cloudinary env vars set): writes to disk like
// before. Fine for testing on your own PC, but images won't survive a
// redeploy on Render — set CLOUDINARY_CLOUD_NAME etc. before going live.
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, "..", "..", "uploads")),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage: cloudinaryConfigured ? memoryStorage : diskStorage,
  fileFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 6 },
});

module.exports = { upload, cloudinaryConfigured };
