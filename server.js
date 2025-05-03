const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const slugify = require("slugify");
const axios = require("axios");
const https = require("https"); // Added missing import
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();
const nodemailer = require("nodemailer");
const emailService = require("./email-service"); // Make sure the path matches where you save the file

// Initialize email service when your app starts
emailService.initializeEmailTransporter();

const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `https://localhost:${PORT}`;

// Midtrans configuration
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY;
const MIDTRANS_SNAP_URL = process.env.MIDTRANS_SNAP_URL;

// Helper function for payment status
function getStatusDetail(status) {
  switch (status) {
    case "success":
      return "Pembayaran berhasil dikonfirmasi";
    case "pending":
      return "Menunggu pembayaran";
    case "failed":
      return "Pembayaran gagal atau dibatalkan";
    case "fraud":
      return "Pembayaran ditolak karena terindikasi fraud";
    default:
      return "Status tidak diketahui";
  }
}

// Helper function to generate a unique ID
function generateUniqueId() {
  return uuidv4();
}

// Enable CORS for development
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Configure SSL certificates
try {
  const certPath = path.join(__dirname, "certs", "ca-certificates.pem");
  if (fs.existsSync(certPath)) {
    process.env.NODE_EXTRA_CA_CERTS = certPath;
    console.log("Using custom CA certificates from:", certPath);
  }
} catch (e) {
  console.warn("Could not load custom certificates:", e.message);
}

// GET Midtrans client key
app.get(
  "https://rabbit-moon.up.railway.app/api/midtrans-client-key",
  (req, res) => {
    res.json({ clientKey: MIDTRANS_CLIENT_KEY });
  }
);
app.get(
  "https://rabbit-moon.up.railway.app//invitation/:slug",
  async (req, res) => {
    const { slug } = req.params;

    try {
      const [rows] = await db.execute(
        "SELECT * FROM invitations WHERE slug = ?",
        [slug]
      );

      if (rows.length === 0) {
        return res.status(404).send("Undangan tidak ditemukan.");
      }

      const invitation = rows[0];
      const templatePath = path.join(
        __dirname,
        "templates",
        `${invitation.template}.html`
      );

      if (!fs.existsSync(templatePath)) {
        return res.status(404).send("Template tidak ditemukan.");
      }

      let htmlContent = fs.readFileSync(templatePath, "utf8");

      // Ubah nilai template
      Object.entries(invitation).forEach(([key, value]) => {
        const val = typeof value === "string" ? value : "";
        htmlContent = htmlContent.replace(new RegExp(`{{${key}}}`, "g"), val);
      });

      // Gallery
      htmlContent = htmlContent.replace(
        /{{galleryPhotos}}/g,
        generateGalleryHTML(invitation.galleryPhotos)
      );

      res.send(htmlContent);
    } catch (error) {
      console.error("Error rendering invitation:", error);
      res.status(500).send("Terjadi kesalahan saat menampilkan undangan.");
    }
  }
);

app.get(
  "https://rabbit-moon.up.railway.app/api/templates",
  async (req, res) => {
    try {
      const [rows] = await db.execute("SELECT * FROM templates");
      const templates = rows.map((row) => ({
        id: row.id,
        name: row.name,
        thumbnail: row.thumbnail,
        isPremium: row.is_premium === 1,
        price: row.price,
      }));
      res.json({ success: true, templates });
    } catch (error) {
      console.error("Error fetching templates:", error);
      res
        .status(500)
        .json({ success: false, message: "Gagal mengambil data template." });
    }
  }
);
app.get("https://rabbit-moon.up.railway.app/api/template/:templateId/info", async (req, res) => {
  const { templateId } = req.params;
  try {
    const [rows] = await db.execute(
      "SELECT * FROM templates WHERE id = ? OR name = ?",
      [templateId, templateId]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Template tidak ditemukan." });
    }

    const template = rows[0];
    res.json({
      success: true,
      template: {
        id: template.id,
        name: template.name,
        isPremium: template.is_premium === 1,
        price: template.price,
        thumbnail: template.thumbnail,
      },
    });
  } catch (error) {
    console.error("Error fetching template info:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil info template.",
    });
  }
});
app.get("https://rabbit-moon.up.railway.app/api/template/:templateId", async (req, res) => {
  const { templateId } = req.params;
  try {
    const templatePath = path.join(
      __dirname,
      "templates",
      `${templateId}.html`
    );
    if (!fs.existsSync(templatePath)) {
      return res
        .status(404)
        .json({ success: false, message: "Template tidak ditemukan." });
    }
    const htmlContent = fs.readFileSync(templatePath, "utf8");
    res.json({ success: true, template: htmlContent });
  } catch (error) {
    console.error("Error loading template preview:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat preview template." });
  }
});
app.post(
  "https://rabbit-moon.up.railway.app/api/create-payment",
  async (req, res) => {
    const { templateId, price } = req.body;
    console.log("📥 [create-payment] Request body:", req.body);

    if (!templateId || !price) {
      console.warn("⚠️ [create-payment] Missing templateId or price");
      return res.status(400).json({
        success: false,
        message: "Template ID dan harga wajib diisi.",
      });
    }

    try {
      const [templateRows] = await db.execute(
        "SELECT * FROM templates WHERE id = ? AND is_premium = 1",
        [templateId]
      );
      console.log("🔍 [create-payment] Template lookup result:", templateRows);

      if (templateRows.length === 0) {
        console.warn("⚠️ [create-payment] Template premium tidak ditemukan");
        return res.status(404).json({
          success: false,
          message: "Template premium tidak ditemukan",
        });
      }

      const template = templateRows[0];
      if (Number(template.price) !== Number(price)) {
        console.warn("⚠️ [create-payment] Harga tidak sesuai:", {
          expected: template.price,
          received: price,
        });
        return res.status(400).json({
          success: false,
          message: "Harga tidak sesuai",
          expectedPrice: template.price,
          receivedPrice: price,
        });
      }

      const timestamp = new Date().getTime();
      const randomStr = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();
      const orderId = `ORDER-${timestamp}-${randomStr}`;
      console.log("🆔 [create-payment] Generated Order ID:", orderId);

      await db.execute(
        "INSERT INTO transactions (order_id, template_id, amount, status, created_at) VALUES (?, ?, ?, ?, NOW())",
        [orderId, templateId, price, "pending"]
      );

      // Format tanggal
      const now = new Date();
      const formattedDate = `${now.getFullYear()}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now
        .getHours()
        .toString()
        .padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now
        .getSeconds()
        .toString()
        .padStart(2, "0")} +0700`;
      console.log("🕒 [create-payment] Formatted start_time:", formattedDate);

      const midtransData = {
        transaction_details: {
          order_id: orderId,
          gross_amount: parseInt(price),
        },
        credit_card: { secure: true },
        customer_details: {
          first_name: "Wedding",
          last_name: "Customer",
          email: "customer@example.com",
          phone: "08123456789",
        },
        item_details: [
          {
            id: templateId,
            price: parseInt(price),
            quantity: 1,
            name: `Template Premium: ${template.name}`,
          },
        ],
        callbacks: {
          finish: `${BASE_URL}/payment-callback?status=success&order_id=${orderId}`,
          error: `${BASE_URL}/payment-callback?status=failed&order_id=${orderId}`,
          pending: `${BASE_URL}/payment-callback?status=pending&order_id=${orderId}`,
        },
        expiry: {
          start_time: formattedDate,
          unit: "hour",
          duration: 24,
        },
      };

      console.log(
        "📦 [create-payment] Midtrans request payload:",
        midtransData
      );

      const response = await axios.post(MIDTRANS_SNAP_URL, midtransData, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(
            MIDTRANS_SERVER_KEY + ":"
          ).toString("base64")}`,
        },
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      console.log("✅ [create-payment] Midtrans response:", response.data);

      if (!response.data.token) {
        throw new Error("No token received from Midtrans");
      }

      res.json({
        success: true,
        token: response.data.token,
        orderId,
        redirectUrl: response.data.redirect_url,
      });
    } catch (error) {
      console.error("❌ [create-payment] Error:", error);
      res.status(500).json({
        success: false,
        message: "Internal Server Error saat create-payment",
        error: error.message,
      });
    }
  }
);
app.post(
  "https://rabbit-moon.up.railway.app/api/payment-notification",
  async (req, res) => {
    try {
      const notification = req.body;
      console.log(
        "📥 [payment-notification] Received:",
        JSON.stringify(notification, null, 2)
      );

      // Extract important fields from the notification
      const {
        order_id,
        transaction_status,
        fraud_status,
        status_code,
        transaction_id,
        payment_type,
        gross_amount,
        signature_key,
      } = notification;

      // Validate order_id exists
      if (!order_id) {
        console.error("⚠️ [payment-notification] Invalid: missing order_id");
        return res.status(400).send("Bad Request: Missing order_id");
      }

      // Verify the notification signature (if signature_key is present)
      if (signature_key) {
        // Implement signature verification logic here if needed
        console.log(
          "🔑 [payment-notification] Received signature key:",
          signature_key
        );
      }

      // Log the important payment information
      console.log(
        `ℹ️ [payment-notification] Processing for order ${order_id}:`
      );
      console.log(`- Type: ${payment_type}`);
      console.log(`- Status: ${transaction_status}`);
      console.log(`- Fraud: ${fraud_status}`);
      console.log(`- Code: ${status_code}`);
      console.log(`- Amount: ${gross_amount}`);

      // Determine the payment status
      let status = "pending";

      if (
        transaction_status === "capture" ||
        transaction_status === "settlement"
      ) {
        if (fraud_status === "accept" || !fraud_status) {
          status = "success";
          console.log(
            `✅ [payment-notification] Payment SUCCESS for order ${order_id}`
          );
        } else {
          status = "fraud";
          console.log(
            `⚠️ [payment-notification] Payment FRAUD for order ${order_id}`
          );
        }
      } else if (
        ["cancel", "deny", "expire", "failure"].includes(transaction_status)
      ) {
        status = "failed";
        console.log(
          `❌ [payment-notification] Payment FAILED for order ${order_id}`
        );
      } else {
        console.log(
          `⏳ [payment-notification] Payment still PENDING for order ${order_id}`
        );
      }

      // Find the transaction in database
      const [existingRows] = await db.execute(
        "SELECT * FROM transactions WHERE order_id = ?",
        [order_id]
      );

      if (existingRows.length === 0) {
        console.error(
          `⚠️ [payment-notification] Order ${order_id} not found in database`
        );
        return res.status(404).send("Order not found");
      }

      const currentStatus = existingRows[0].status;
      console.log(
        `ℹ️ [payment-notification] Current status in DB: ${currentStatus}, New status: ${status}`
      );

      // Only update if status actually changed
      if (currentStatus !== status) {
        console.log(
          `🔄 [payment-notification] Updating status for order ${order_id} from ${currentStatus} to ${status}`
        );

        // Update transaction status and payment details
        await db.execute(
          "UPDATE transactions SET status = ?, transaction_id = ?, payment_type = ?, updated_at = NOW() WHERE order_id = ?",
          [status, transaction_id || null, payment_type || null, order_id]
        );

        console.log(
          `✅ [payment-notification] Transaction ${order_id} updated successfully`
        );
      } else {
        console.log(
          `ℹ️ [payment-notification] No status change needed for order ${order_id}`
        );
      }

      // Always return 200 to Midtrans to acknowledge receipt
      return res.status(200).send("OK");
    } catch (error) {
      console.error("❌ [payment-notification] Error processing:", error);
      // Still return 200 to avoid Midtrans retrying
      return res.status(200).send("Error processed");
    }
  }
);
app.get(
  "https://rabbit-moon.up.railway.app/api/payment-status/:orderId",
  async (req, res) => {
    const { orderId } = req.params;
    console.log("📥 [payment-status] Checking status for order:", orderId);

    try {
      // First check our database
      const [rows] = await db.execute(
        "SELECT * FROM transactions WHERE order_id = ?",
        [orderId]
      );

      if (rows.length === 0) {
        console.warn("⚠️ [payment-status] Transaction not found:", orderId);
        return res
          .status(404)
          .json({ success: false, message: "Transaksi tidak ditemukan" });
      }

      let status = rows[0].status;
      let transactionData = rows[0];
      console.log("🔍 [payment-status] Found transaction with status:", status);

      // Always check with Midtrans directly for the latest status
      try {
        console.log(
          "🔄 [payment-status] Checking with Midtrans for latest status"
        );
        const midtransUrl = `https://api.midtrans.com/v2/${orderId}/status`;

        // Create HTTPS agent that ignores certificate errors
        // WARNING: In production, you should NOT use this approach
        const httpsAgent = new https.Agent({
          rejectUnauthorized: false, // Disable certificate validation - ONLY FOR DEVELOPMENT
        });

        const midtransResponse = await axios.get(midtransUrl, {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(
              MIDTRANS_SERVER_KEY + ":"
            ).toString("base64")}`,
          },
          timeout: 10000, // 10 second timeout
          httpsAgent: httpsAgent, // Use the custom agent that ignores certificate issues
        });

        console.log(
          `💡 [payment-status] Midtrans status for ${orderId}:`,
          JSON.stringify(midtransResponse.data, null, 2)
        );

        const midtransStatus = midtransResponse.data.transaction_status;
        const fraudStatus = midtransResponse.data.fraud_status;
        const paymentType = midtransResponse.data.payment_type;

        // Update transaction data with Midtrans response
        transactionData = {
          ...transactionData,
          midtrans_status: midtransStatus,
          payment_type: paymentType,
        };

        // Update status based on Midtrans response
        let statusChanged = false;
        let newStatus = status;

        if (
          (midtransStatus === "capture" || midtransStatus === "settlement") &&
          (fraudStatus === "accept" || !fraudStatus)
        ) {
          newStatus = "success";
          statusChanged = newStatus !== status;
          status = newStatus;

          // Update in database if changed
          if (statusChanged) {
            console.log(
              `🔄 [payment-status] Updating status to success for order: ${orderId}`
            );
            await db.execute(
              "UPDATE transactions SET status = ?, payment_type = ?, updated_at = NOW() WHERE order_id = ?",
              [status, paymentType || null, orderId]
            );
          }
        } else if (
          ["cancel", "deny", "expire", "failure"].includes(midtransStatus)
        ) {
          newStatus = "failed";
          statusChanged = newStatus !== status;
          status = newStatus;

          // Update in database if changed
          if (statusChanged) {
            console.log(
              `🔄 [payment-status] Updating status to failed for order: ${orderId}`
            );
            await db.execute(
              "UPDATE transactions SET status = ?, payment_type = ?, updated_at = NOW() WHERE order_id = ?",
              [status, paymentType || null, orderId]
            );
          }
        }

        if (statusChanged) {
          console.log(
            `✅ [payment-status] Status updated from ${transactionData.status} to ${status}`
          );
        } else {
          console.log(`ℹ️ [payment-status] Status unchanged: ${status}`);
        }
      } catch (midtransError) {
        console.error(
          "❌ [payment-status] Error checking Midtrans status:",
          midtransError.message
        );
        if (midtransError.response) {
          console.error("Midtrans error details:", {
            status: midtransError.response.status,
            data: midtransError.response.data,
          });
        }
        // Continue with the current database status
        console.log(`ℹ️ [payment-status] Using database status: ${status}`);
      }

      res.json({
        success: true,
        data: {
          ...transactionData,
          status,
          statusDetail: getStatusDetail(status),
        },
      });
    } catch (error) {
      console.error(
        "❌ [payment-status] Error fetching payment status:",
        error
      );
      res
        .status(500)
        .json({ success: false, message: "Error fetching payment status" });
    }
  }
);
async function checkPaymentStatus(orderId) {
  console.log(
    `🔍 [checkPaymentStatus] Checking payment status for order ${orderId}`
  );

  try {
    // First check our database
    const [rows] = await db.execute(
      "SELECT status FROM transactions WHERE order_id = ?",
      [orderId]
    );

    if (rows.length === 0) {
      console.warn(
        `⚠️ [checkPaymentStatus] Order ${orderId} not found in database`
      );
      return "failed";
    }

    const status = rows[0].status;
    console.log(
      `ℹ️ [checkPaymentStatus] Database status for ${orderId}: ${status}`
    );

    return status;
  } catch (error) {
    console.error(
      `❌ [checkPaymentStatus] Error checking payment status: ${error.message}`
    );
    throw error;
  }
}
async function getTemplate(templateId) {
  console.log(`🔍 [getTemplate] Looking up template with ID: ${templateId}`);

  try {
    const [rows] = await db.execute(
      "SELECT * FROM templates WHERE id = ? OR name = ?",
      [templateId, templateId]
    );

    if (rows.length === 0) {
      console.warn(`⚠️ [getTemplate] Template ${templateId} not found`);
      throw new Error(`Template not found: ${templateId}`);
    }

    const template = rows[0];
    console.log(`✅ [getTemplate] Found template: ${template.name}`);

    return {
      id: template.id,
      name: template.name,
      isPremium: template.is_premium === 1,
      price: template.price,
    };
  } catch (error) {
    console.error(`❌ [getTemplate] Error fetching template: ${error.message}`);
    throw error;
  }
}

async function saveInvitation(data) {
  console.log(
    `📝 [saveInvitation] Saving invitation data for guest: ${data.guest}`
  );
  const { guest, templateId, orderId, formData, mediaData } = data;

  try {
    // Generate a URL-friendly slug from the guest name
    const slug = slugify(`${guest}-${Date.now()}`, {
      lower: true,
      strict: true,
    });

    // First, get the database columns to ensure we're only using existing ones
    const [columnsResult] = await db.execute("SHOW COLUMNS FROM invitations");
    const columnNames = columnsResult.map((col) => col.Field);
    console.log("Existing database columns:", columnNames);

    // Create dynamic SQL based on existing columns
    let columns = [];
    let placeholders = [];
    let values = [];

    // Always include these core fields
    columns.push("slug", "template", "guest", "created_at");
    placeholders.push("?", "?", "?", "NOW()");
    values.push(slug, templateId, guest);

    // Include transaction ID if provided
    if (orderId && columnNames.includes("order_id")) {
      columns.push("order_id");
      placeholders.push("?");
      values.push(orderId);
    }

    // Process form data fields
    // Extract all form fields
    for (const [field, value] of Object.entries(formData)) {
      if (
        columnNames.includes(field) &&
        value !== null &&
        value !== undefined
      ) {
        columns.push(field);
        placeholders.push("?");
        values.push(value);
      }
    }

    // Process media data fields
    if (mediaData && typeof mediaData === "object") {
      // Handle main photo - support both legacy and new structure
      if (mediaData.mainPhoto && columnNames.includes("photoLink")) {
        columns.push("photoLink");
        placeholders.push("?");
        values.push(mediaData.mainPhoto);
        console.log(
          `📸 [saveInvitation] Adding main photo: ${mediaData.mainPhoto}`
        );
      } else if (
        mediaData.photos &&
        mediaData.photos.main &&
        columnNames.includes("photoLink")
      ) {
        columns.push("photoLink");
        placeholders.push("?");
        values.push(mediaData.photos.main);
        console.log(
          `📸 [saveInvitation] Adding main photo: ${mediaData.photos.main}`
        );
      }

      // Handle music - support both legacy and new structure
      if (mediaData.backgroundMusic && columnNames.includes("musicLink")) {
        columns.push("musicLink");
        placeholders.push("?");
        values.push(mediaData.backgroundMusic);
        console.log(
          `🎵 [saveInvitation] Adding music: ${mediaData.backgroundMusic}`
        );
      } else if (
        mediaData.music &&
        mediaData.music.url &&
        columnNames.includes("musicLink")
      ) {
        columns.push("musicLink");
        placeholders.push("?");
        values.push(mediaData.music.url);
        console.log(`🎵 [saveInvitation] Adding music: ${mediaData.music.url}`);
      }

      // Handle bride photo - support both legacy and new structure
      if (mediaData.bridePhoto && columnNames.includes("bridePhoto")) {
        columns.push("bridePhoto");
        placeholders.push("?");
        values.push(mediaData.bridePhoto);
        console.log(
          `👰 [saveInvitation] Adding bride photo: ${mediaData.bridePhoto}`
        );
      } else if (
        mediaData.photos &&
        mediaData.photos.bride &&
        columnNames.includes("bridePhoto")
      ) {
        columns.push("bridePhoto");
        placeholders.push("?");
        values.push(mediaData.photos.bride);
        console.log(
          `👰 [saveInvitation] Adding bride photo: ${mediaData.photos.bride}`
        );
      }

      // Handle groom photo - support both legacy and new structure
      if (mediaData.groomPhoto && columnNames.includes("groomPhoto")) {
        columns.push("groomPhoto");
        placeholders.push("?");
        values.push(mediaData.groomPhoto);
        console.log(
          `🤵 [saveInvitation] Adding groom photo: ${mediaData.groomPhoto}`
        );
      } else if (
        mediaData.photos &&
        mediaData.photos.groom &&
        columnNames.includes("groomPhoto")
      ) {
        columns.push("groomPhoto");
        placeholders.push("?");
        values.push(mediaData.photos.groom);
        console.log(
          `🤵 [saveInvitation] Adding groom photo: ${mediaData.photos.groom}`
        );
      }

      // Handle gallery photos - support both legacy and new structure
      if (mediaData.galleryPhotos && columnNames.includes("galleryPhotos")) {
        let galleryData;
        if (Array.isArray(mediaData.galleryPhotos)) {
          galleryData = JSON.stringify(mediaData.galleryPhotos);
        } else if (typeof mediaData.galleryPhotos === "string") {
          try {
            // Check if it's already a valid JSON string
            JSON.parse(mediaData.galleryPhotos);
            galleryData = mediaData.galleryPhotos;
          } catch (e) {
            // If not valid JSON, store as a single item array
            galleryData = JSON.stringify([mediaData.galleryPhotos]);
          }
        } else {
          // For other types, convert to string and put in array
          galleryData = JSON.stringify([String(mediaData.galleryPhotos)]);
        }

        columns.push("galleryPhotos");
        placeholders.push("?");
        values.push(galleryData);
        console.log(
          `🖼️ [saveInvitation] Adding gallery photos: ${galleryData}`
        );
      } else if (
        mediaData.photos &&
        mediaData.photos.gallery &&
        columnNames.includes("galleryPhotos")
      ) {
        let galleryData;
        if (Array.isArray(mediaData.photos.gallery)) {
          galleryData = JSON.stringify(mediaData.photos.gallery);
        } else if (typeof mediaData.photos.gallery === "string") {
          try {
            // Check if it's already a valid JSON string
            JSON.parse(mediaData.photos.gallery);
            galleryData = mediaData.photos.gallery;
          } catch (e) {
            // If not valid JSON, store as a single item array
            galleryData = JSON.stringify([mediaData.photos.gallery]);
          }
        } else {
          // For other types, convert to string and put in array
          galleryData = JSON.stringify([String(mediaData.photos.gallery)]);
        }

        columns.push("galleryPhotos");
        placeholders.push("?");
        values.push(galleryData);
        console.log(
          `🖼️ [saveInvitation] Adding gallery photos: ${galleryData}`
        );
      }
    }

    // Create the SQL query
    const sql = `
      INSERT INTO invitations (
        ${columns.join(", ")}
      ) VALUES (${placeholders.join(", ")})
    `;

    console.log(`🔧 [saveInvitation] Executing SQL:`, sql);
    console.log(`🔧 [saveInvitation] With values:`, values);

    // Insert the invitation into the database
    const [result] = await db.execute(sql, values);
    const insertId = result.insertId;

    console.log(
      `✅ [saveInvitation] Successfully saved invitation for guest: ${guest}, id: ${insertId}, slug: ${slug}`
    );
    return { id: insertId, slug };
  } catch (error) {
    console.error(
      `❌ [saveInvitation] Error saving invitation: ${error.message}`
    );
    console.error("Full error:", error);
    throw error;
  }
}

app.post(
  "https://rabbit-moon.up.railway.app/api/generate",
  async (req, res) => {
    console.log("🚀 [generate] Generate API called");
    try {
      const { templateId, orderId, formData, mediaData, userEmail } = req.body;

      // Debug log the entire request body to see what's coming in
      console.log(
        "📥 [generate] FULL REQUEST BODY:",
        JSON.stringify(req.body, null, 2)
      );

      // Log if email is provided
      if (userEmail) {
        console.log(`📧 [generate] User email provided: ${userEmail}`);
      } else {
        console.log(`⚠️ [generate] No user email provided`);
      }

      // Specifically check the mediaData structure
      console.log(
        "🖼️ [generate] MEDIA DATA:",
        mediaData ? JSON.stringify(mediaData, null, 2) : "No media data found"
      );

      // Verifikasi jika template premium dan pembayaran sudah berhasil
      let templateInfo = { name: "Basic Template" };
      if (templateId) {
        try {
          // Use our own getTemplate helper instead of db.getTemplate
          const template = await getTemplate(templateId);
          console.log(`ℹ️ [generate] Template info:`, template);
          templateInfo = template;

          if (template.isPremium) {
            if (!orderId) {
              console.warn(
                "⚠️ [generate] Payment required for premium template but no orderId provided"
              );
              return res.json({
                success: false,
                message: "Pembayaran diperlukan untuk template premium",
              });
            }

            const paymentStatus = await checkPaymentStatus(orderId);
            console.log(
              `🔍 [generate] Payment status for ${orderId}: ${paymentStatus}`
            );

            if (paymentStatus !== "success") {
              console.warn(
                `⚠️ [generate] Payment verification failed: ${paymentStatus}`
              );
              return res.json({
                success: false,
                message:
                  "Verifikasi pembayaran gagal. Status: " + paymentStatus,
              });
            }
          }
        } catch (error) {
          console.error(
            `❌ [generate] Error checking template/payment: ${error.message}`
          );
          return res.json({
            success: false,
            message: "Error checking template or payment: " + error.message,
          });
        }
      }

      // FIX #1: Make sure guests is properly initialized
      if (!formData.guests) {
        formData.guests = [];
        console.warn("⚠️ [generate] Initializing empty guests array");
      }

      // FIX #2: If guests is a string (common error), convert it to an array
      if (typeof formData.guests === "string") {
        try {
          // Try to parse if it's a JSON string
          formData.guests = JSON.parse(formData.guests);
          console.log(
            "🔄 [generate] Converted guests from JSON string to array"
          );
        } catch (e) {
          // If it's just a plain string, make it an array with one element
          formData.guests = [formData.guests];
          console.log("🔄 [generate] Converted guest string to array");
        }
      }

      // FIX #3: Ensure guests is an array
      if (!Array.isArray(formData.guests)) {
        console.warn(
          "⚠️ [generate] guests is not an array, converting to array"
        );
        // Convert to array with a single item if it's a defined value
        formData.guests = formData.guests ? [formData.guests] : [];
      }

      // Check if the guests array is empty
      if (formData.guests.length === 0) {
        console.warn("⚠️ [generate] Guest list is empty");
        return res.json({
          success: false,
          message: "Daftar tamu tidak boleh kosong",
        });
      }

      // Generate links untuk setiap tamu
      const links = [];
      console.log(`🔄 [generate] Processing ${formData.guests.length} guests`);

      // FIX #4: Better handling of guest processing
      for (let i = 0; i < formData.guests.length; i++) {
        let guest = formData.guests[i];
        // Handle case when guest is an object with a name property
        if (typeof guest === "object" && guest !== null && guest.name) {
          guest = guest.name;
        }

        // Convert to string and trim
        guest = String(guest).trim();

        if (guest !== "") {
          try {
            console.log(`🧑 [generate] Processing guest: "${guest}"`);

            // Generate ID unik untuk undangan ini
            const invitationId = generateUniqueId();
            console.log(
              `🆔 [generate] Generated invitation ID: ${invitationId} for guest: ${guest}`
            );

            // Simpan data undangan ke database
            const result = await saveInvitation({
              id: invitationId,
              templateId,
              orderId,
              guest,
              formData,
              mediaData: mediaData || {}, // Ensure mediaData is not undefined
            });

            // Buat link untuk tamu ini
            const link = `${BASE_URL}/invitation/${result.slug}`;
            links.push({ guest, link });
            console.log(
              `✅ [generate] Created link for guest ${guest}: ${link}`
            );
          } catch (error) {
            console.error(
              `❌ [generate] Error processing guest ${guest}: ${error.message}`
            );
            // Log full error details for debugging
            console.error(`Full error:`, error);
            // Continue with other guests
          }
        } else {
          console.warn(`⚠️ [generate] Skipping empty guest at index ${i}`);
        }
      }

      // Jika tidak ada link yang dibuat
      if (links.length === 0) {
        console.warn("⚠️ [generate] No valid links were created");
        return res.json({
          success: false,
          message:
            "Tidak ada tautan yang dibuat. Pastikan daftar tamu tidak kosong dan ada minimal satu nama yang valid.",
        });
      }

      // Send email if user provided an email address
      let emailSent = false;
      if (userEmail) {
        try {
          emailSent = await emailService.sendInvitationLinks(
            userEmail,
            links,
            templateInfo
          );
          console.log(
            `📧 [generate] Email sending ${emailSent ? "successful" : "failed"}`
          );
        } catch (error) {
          console.error(`❌ [generate] Error sending email: ${error.message}`);
          // Continue even if email fails - we'll still return the links
        }
      }

      // Kembalikan links yang berhasil dibuat
      console.log(
        `🎉 [generate] Successfully created ${links.length} invitation links`
      );
      return res.json({
        success: true,
        links,
        emailSent: emailSent && userEmail ? true : false,
        emailAddress: userEmail || null,
      });
    } catch (error) {
      console.error("❌ [generate] Error generating invitations:", error);
      // Log full error for debugging
      console.error("Full error:", error);
      return res.json({
        success: false,
        message: "Error generating invitations: " + error.message,
      });
    }
  }
);
function generateGalleryHTML(galleryArrayString) {
  let photos;
  try {
    photos = JSON.parse(galleryArrayString);
  } catch (error) {
    console.error("Error parsing gallery photos:", error);
    return "";
  }

  if (!Array.isArray(photos)) {
    return "";
  }

  return photos
    .map((photo) => `<img src="${photo}" alt="gallery photo" />`)
    .join("\n");
}
app.listen(PORT, () => {
 
});
