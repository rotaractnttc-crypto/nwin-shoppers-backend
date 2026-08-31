const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null; // email not configured yet — see .env.example
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_PORT === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendOtpEmail(to, code) {
  const t = getTransporter();
  if (!t) {
    // Email isn't configured yet — log the code so you can still test locally.
    console.log(`\n[DEV] No SMTP configured. Verification code for ${to}: ${code}\n`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || `"Nwin Shoppers" <${process.env.SMTP_USER}>`,
    to,
    subject: "Your Nwin Shoppers verification code",
    text: `Your verification code is ${code}. It expires in 15 minutes.`,
    html: `<p>Your Nwin Shoppers verification code is:</p>
           <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
           <p>This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}

module.exports = { sendOtpEmail };
