// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";

// Load environment variables locally (Vercel loads them automatically)
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CREATOR_NAME = "Eli Bautista";

// --- GOOGLE SHEETS CONFIG (OLD VARIABLES USED FOR DEBUGGING) ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";
// These are deprecated in favor of the BASE64 key, but kept for debugging the old error
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const BASE64_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64; // NEW: The robust key

// -------------------------------------------------------------------
// 1. Client Setup & Authentication (CRITICAL FIX IMPLEMENTED HERE)
// -------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash";

let sheets;
let auth;
let authError = null;

try {
  let credentials = {};

  // 1. Check if the robust BASE64 key is available
  if (BASE64_CREDENTIALS) {
    // Decode the entire JSON file contents
    const decodedCredentialsString = Buffer.from(
      BASE64_CREDENTIALS,
      "base64"
    ).toString("utf-8");
    credentials = JSON.parse(decodedCredentialsString);
    console.log("--- AUTH: Using Base64 Credentials (Robust Method) ---");
  } else {
    // Fallback to the old method (which is currently failing)
    console.log(
      "--- AUTH: Falling back to Raw Key Method (Expect OpenSSL Error) ---"
    );
    credentials.client_email = GOOGLE_CLIENT_EMAIL;
    credentials.private_key = GOOGLE_PRIVATE_KEY
      ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      : "";
  }

  // 2. Initialize JWT Client
  auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  // 3. Initialize Sheets Client
  sheets = google.sheets({ version: "v4", auth });
} catch (error) {
  // Catch the decoding or initialization error
  authError = error;
  console.error(
    "FATAL AUTH ERROR: Key failed to decode/authenticate. Check BASE64 format.",
    error.message
  );
  sheets = null;
}

// --- DEBUG LOGS FOR VERCEL ---
console.log("--- ENV CHECK START ---");
console.log(`SHEET ID: ${SPREADSHEET_ID}`);
console.log(`Auth Status: ${sheets ? "Initialized" : "FAILED"}`);
console.log(
  `Base64 Variable Status: ${BASE64_CREDENTIALS ? "PRESENT" : "MISSING"}`
);
console.log("--- ENV CHECK END ---");
// -----------------------------

// --- Gemini Schema Definition ---
const expenseSchema = z.object({
  description: z
    .string()
    .describe("A brief description of the expense item..."),
  amount: z.number().describe("The numerical value of the expense..."),
  category: z
    .enum([
      "Food",
      "Transportation",
      "Supplies",
      "Utilities",
      "Personal",
      "Other",
    ])
    .describe("The assigned expense category."),
});
const responseSchema = z.array(expenseSchema);
const jsonSchema = zodToJsonSchema(responseSchema);

// -------------------------------------------------------------------
// 2. Google Sheets Functions
// -------------------------------------------------------------------

/**
 * Uses Gemini to parse Philippine expense text into structured JSON data.
 */
const parseExpensesWithAI = async (text) => {
  const prompt = `You are an expert financial assistant operating in the Philippines. Analyze the following user input and extract all separate expenses. Assume all currency is in Philippine Peso (PHP) unless otherwise specified. Input: "${text}"`;

  const response = await ai.models.generateContent({
    model: model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
    },
  });

  const rawJson = response.text.trim();
  const parsedData = JSON.parse(rawJson);
  const date = new Date().toLocaleDateString("en-PH");

  return parsedData.map((record) => ({ ...record, date }));
};

/**
 * Appends records to the Google Sheet.
 */
const appendRecordsToSheet = async (records) => {
  // Check for authentication failure before proceeding
  if (!sheets) {
    // Re-throw the original auth error
    throw new Error(
      authError
        ? authError.message
        : "Authentication failed during initialization."
    );
  }

  const rows = records.map((r) => [
    r.date,
    r.description,
    r.amount,
    r.category,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
    valueInputOption: "USER_ENTERED",
    resource: {
      values: rows,
    },
  });
};

// ... (getStatsFromSheet remains the same, using the global 'sheets' client) ...
const getStatsFromSheet = async () => {
  // Check for authentication failure before proceeding
  if (!sheets) {
    throw new Error(
      authError
        ? authError.message
        : "Authentication failed during initialization."
    );
  }
  // ... rest of getStatsFromSheet logic ...

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
  });

  const rows = response.data.values ? response.data.values.slice(1) : [];

  let totalAmount = 0;
  const categoryTotals = {};
  let recordCount = 0;

  for (const row of rows) {
    const amount = parseFloat(row[2]);
    const category = row[3] || "Other";

    if (!isNaN(amount)) {
      totalAmount += amount;
      recordCount++;
      categoryTotals[category] = (categoryTotals[category] || 0) + amount;
    }
  }

  if (recordCount === 0) {
    return { summary: "No expenses found in Google Sheet." };
  }

  const averageExpense = totalAmount / recordCount;
  const topCategory = Object.entries(categoryTotals).reduce(
    (a, b) => (a[1] > b[1] ? a : b),
    ["", 0]
  );

  let categoryBreakdown = Object.entries(categoryTotals)
    .map(([cat, sum]) => `\n   - ${cat}: ₱${sum.toFixed(2)}`)
    .join("");

  const summary = `
📊 **KwentaKo Statistics Summary**
---
* **Total Expenses Recorded:** ${recordCount}
* **Total Spending (Lifetime):** ₱${totalAmount.toFixed(2)}
* **Average Expense Amount:** ₱${averageExpense.toFixed(2)}
* **Top Category:** ${topCategory[0]} (₱${topCategory[1].toFixed(2)})

**Category Breakdown:**${categoryBreakdown}

📁 **Data Source:** Google Sheet
* **Created by:** ${CREATOR_NAME}
    `;

  return { summary };
};
// ... (End of getStatsFromSheet) ...

// -------------------------------------------------------------------
// 3. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses, and **Gemini AI** will log them into your Google Sheet. Currency is assumed to be **Philippine Peso (₱)**.

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

bot.help(async (ctx) => {
  const helpMessage = `
📚 **Available Commands:**
* \`/download_csv\`: Sends you the latest statistics and a download link.

Bot created by **${CREATOR_NAME}**.
    `;
  ctx.replyWithMarkdown(helpMessage);
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    await ctx.reply("🤖 Analyzing expense with Gemini AI...");

    const newRecords = await parseExpensesWithAI(text);

    if (newRecords.length === 0) {
      return ctx.reply(
        "AI could not extract any expenses. Please try a different phrasing, specifying the amount clearly."
      );
    }

    // --- WRITE TO GOOGLE SHEETS ---
    // If successful, this line means the Base64 key worked.
    await appendRecordsToSheet(newRecords);

    const total = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    ctx.reply(
      `✅ Saved ${
        newRecords.length
      } items to Google Sheet. Total: ₱${total.toFixed(2)}`
    );
  } catch (error) {
    // Log the full error object to Vercel logs for inspection
    console.error("Error processing with Sheets:", error);

    // Reply to the user with the authentication message
    ctx.reply(
      "Error saving data. If this persists, the Google Sheet credentials (Private Key or Sharing Permissions) are incorrect."
    );
  }
});

// Command to download the data
bot.command("download_csv", async (ctx) => {
  try {
    const { summary } = await getStatsFromSheet();

    await ctx.replyWithMarkdown(summary);

    const viewUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
    const downloadUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=xlsx&id=${SPREADSHEET_ID}`;

    await ctx.replyWithHTML(`
📥 **View or Download Your Data:**
* **View Online:** <a href="${viewUrl}">Open Google Sheet</a>
* **Download Excel (.xlsx):** <a href="${downloadUrl}">Download File</a>
        `);
  } catch (error) {
    console.error("Error with Google Sheets API:", error.message);
    ctx.reply(
      "Could not access Google Sheets. Check your API key and Sheet ID/Permissions."
    );
  }
});

// -------------------------------------------------------------------
// 4. Vercel Handler Function (FINAL FIX FOR HTTP HEADERS)
// -------------------------------------------------------------------

export default async (req, res) => {
  try {
    // Handle the incoming webhook from Telegram
    await bot.handleUpdate(req.body, res);

    // Send 200 OK ONLY if the response hasn't been sent by ctx.reply inside the handlers
    if (!res.headersSent) {
      res.status(200).send("OK");
    }
  } catch (error) {
    // Log the execution error (usually occurs if the request structure is bad)
    console.error("Vercel Webhook execution error:", error.message);

    // Ensure we only send a 500 status if no reply was sent via Telegram
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
};
