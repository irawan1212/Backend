const nodemailer = require("nodemailer");
require("dotenv").config();

// Email transporter (will be initialized later)
let transporter = null;

// Initialize email transporter
function initializeEmailTransporter() {
  try {
    // Create a transporter using SMTP settings from environment variables
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || "smtp.gmail.com",
      port: process.env.EMAIL_PORT || 587,
      secure: process.env.EMAIL_SECURE === "true",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    console.log("📧 [emailService] Email transporter initialized");
  } catch (error) {
    console.error(
      "❌ [emailService] Failed to initialize email transporter:",
      error
    );
  }
}

// Send invitation links to user's email
async function sendInvitationLinks(userEmail, links, templateInfo) {
  console.log(`📧 [emailService] Attempting to send email to: ${userEmail}`);

  if (!transporter) {
    console.error("❌ [emailService] Email transporter not initialized");
    return false;
  }

  if (!userEmail || !links || links.length === 0) {
    console.error("❌ [emailService] Missing email address or links");
    return false;
  }

  try {
    // Generate HTML table with all links
    const linksTable = links
      .map(
        (item) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${item.guest}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">
          <a href="${item.link}" target="_blank">${item.link}</a>
        </td>
      </tr>
    `
      )
      .join("");

    // Email content
    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: userEmail,
      subject: "Link Undagan Online anda",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4a6ee0;">Link Undangan</h2>
          
          <p>Untuk Pengguna,</p>
          
          
          <p>Link undangan berdasarkan tamu:</p>
          
          <table style="width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 15px;">
            <thead>
              <tr style="background-color: #f2f2f2;">
                <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Guest Name</th>
                <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Invitation Link</th>
              </tr>
            </thead>
            <tbody>
              ${linksTable}
            </tbody>
          </table>
          <p>Terima kasih telah menggunakan Pembuat Undangan Pernikahan<strong>${
            templateInfo.name || "Selected"
          }</strong> template.</p>
             
          <p style="margin-top: 30px;">Semoga yang terbaik untuk hari istimewa Anda!</p>
          <p>Rabbit Moon</p>
          
          
        </div>
      `,
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ [emailService] Email sent successfully: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`❌ [emailService] Error sending email: ${error.message}`);
    return false;
  }
}

module.exports = {
  initializeEmailTransporter,
  sendInvitationLinks,
};
