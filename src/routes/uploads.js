const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { upload, cloudinaryConfigured } = require("../middleware/upload");
const { uploadBuffer } = require("../config/cloudinary");

const router = express.Router();

// Resolves the uploaded files to permanent URLs — Cloudinary URLs when
// configured, or local /uploads paths otherwise (dev-only, see upload.js).
async function resolveUrls(files, folder) {
  if (cloudinaryConfigured) {
    return Promise.all(files.map((f) => uploadBuffer(f.buffer, folder)));
  }
  return files.map((f) => `/uploads/${f.filename}`);
}

router.post("/product-images", requireAuth, requireRole("seller", "admin"), upload.array("images", 6), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No images uploaded." });
  try {
    const urls = await resolveUrls(req.files, "products");
    res.status(201).json({ urls });
  } catch (err) {
    console.error("product image upload error:", err.message);
    res.status(500).json({ error: "Could not upload images." });
  }
});

router.post("/restaurant-logo", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded." });
  try {
    const [url] = await resolveUrls([req.file], "restaurants");
    res.status(201).json({ url });
  } catch (err) {
    console.error("restaurant logo upload error:", err.message);
    res.status(500).json({ error: "Could not upload image." });
  }
});

router.post("/menu-item-photo", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded." });
  try {
    const [url] = await resolveUrls([req.file], "menu-items");
    res.status(201).json({ url });
  } catch (err) {
    console.error("menu item photo upload error:", err.message);
    res.status(500).json({ error: "Could not upload image." });
  }
});

module.exports = router;
