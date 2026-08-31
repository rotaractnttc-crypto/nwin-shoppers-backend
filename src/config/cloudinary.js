const cloudinary = require("cloudinary").v2;

const configured = !!process.env.CLOUDINARY_CLOUD_NAME;

if (configured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// Uploads a file buffer to Cloudinary and resolves with its permanent HTTPS
// URL. This is what makes product/menu/restaurant photos survive backend
// redeploys — local disk storage on Render gets wiped on every deploy.
function uploadBuffer(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `nwin-shoppers/${folder}`, resource_type: "image" },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

module.exports = { cloudinary, configured, uploadBuffer };
