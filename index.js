// -------------------------------------------------------------------
// 1. Imports and Setup (ESM)
// -------------------------------------------------------------------

import { Telegraf } from "telegraf";
import fs, { promises as fsPromises } from "fs";
import path from "path";
import { createObjectCsvWriter } from "csv-writer";
import csv from "csv-parser";
import http from "http";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Load environment variables
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CSV_FILE = path.join(process.cwd(), "expenses.csv");
const CREATOR_NAME = "Eli Bautista";

if (!BOT_TOKEN || !GEMINI_API_KEY) {
  console.error(
    "FATAL: BOT_TOKEN and GEMINI_API_KEY must be set in the .env file."
  );
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash"; // Fast model optimized for structured data extraction

// Small helper: convert simple Markdown-like markers used in messages to
// HTML so we can use `replyWithHTML` (avoids deprecated Markdown helpers).
const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const simpleMdToHtml = (text) => {
  if (!text) return "";
  let t = escapeHtml(text);
  // Bold: **text**
  t = t.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
  // Inline code: `code`
  t = t.replace(/`([^`]+?)`/gs, "<code>$1</code>");
  // Italic: *text* (do after bold)
  t = t.replace(/\*(.+?)\*/gs, "<i>$1</i>");
  // Preserve newlines as <br>
  t = t.replace(/\n/g, "<br>");
  return t;
};

// -------------------------------------------------------------------
// 2. Data Schema Definition (Zod & JSON)
// -------------------------------------------------------------------

// Define the structure of a single expense record
const expenseSchema = z.object({
  description: z
    .string()
    .describe(
      "A brief description of the expense item, e.g., 'Lunch at Jollibee' or 'Taxi fare'."
    ),
  amount: z
    .number()
    .describe("The numerical value of the expense in Philippine Peso."),
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

// The model must return an array of these objects
const responseSchema = z.array(expenseSchema);
const jsonSchema = zodToJsonSchema(responseSchema);

// -------------------------------------------------------------------
// 3. Helper Functions
// -------------------------------------------------------------------

/**
 * Ensures the CSV file exists with proper headers.
 */
const initializeCsv = async () => {
  const header = [
    { id: "date", title: "Date" },
    { id: "description", title: "Description" },
    { id: "amount", title: "Amount (PHP)" }, // Updated header title
    { id: "category", title: "Category" },
  ];

  if (!fs.existsSync(CSV_FILE)) {
    console.log("CSV file not found. Creating a new one...");
    const csvWriter = createObjectCsvWriter({
      path: CSV_FILE,
      header: header,
      append: false,
    });
    await csvWriter.writeRecords([]); // Write headers
  }
};

/**
 * Uses Gemini to parse Philippine expense text into structured JSON data.
 */
const parseExpensesWithAI = async (text) => {
  // Prompt includes localization context
  const prompt = `You are an expert financial assistant operating in the Philippines. Analyze the following user input and extract all separate expenses. Assume all currency is in Philippine Peso (PHP) unless otherwise specified. Input: "${text}"`;

  const response = await ai.models.generateContent({
    model: model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema, // Guarantees JSON output format
    },
  });

  const rawJson = response.text.trim();
  const parsedData = JSON.parse(rawJson);

  // Use 'en-PH' locale for consistent Philippine date format
  const date = new Date().toLocaleDateString("en-PH");
  return parsedData.map((record) => ({ ...record, date }));
};

/**
 * Reads the CSV and calculates statistics and metadata.
 */
const getStats = async () => {
  if (!fs.existsSync(CSV_FILE)) {
    return { summary: "No expenses recorded yet." };
  }

  let totalAmount = 0;
  const categoryTotals = {};
  let recordCount = 0;

  await new Promise((resolve, reject) => {
    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on("data", (data) => {
        const amount = parseFloat(data["Amount (PHP)"]); // Use updated column name
        const category = data.Category || "Other";

        if (!isNaN(amount)) {
          totalAmount += amount;
          recordCount++;
          categoryTotals[category] = (categoryTotals[category] || 0) + amount;
        }
      })
      .on("end", resolve)
      .on("error", reject);
  });

  if (recordCount === 0) {
    return { summary: "No valid numeric expenses found in the CSV." };
  }

  const fileStats = await fsPromises.stat(CSV_FILE);
  const averageExpense = totalAmount / recordCount;
  const topCategory = Object.entries(categoryTotals).reduce(
    (a, b) => (a[1] > b[1] ? a : b),
    ["", 0]
  );

  // Format the summary message
  let categoryBreakdown = Object.entries(categoryTotals)
    .map(([cat, sum]) => `\n   - ${cat}: ₱${sum.toFixed(2)}`)
    .join("");

  const summaryHtml = `
<b>📊 KwentaKo Statistics Summary</b>
<br>---
<br><b>Total Expenses Recorded:</b> ${recordCount}
<br><b>Total Spending (Lifetime):</b> ₱${totalAmount.toFixed(2)}
<br><b>Average Expense Amount:</b> ₱${averageExpense.toFixed(2)}
<br><b>Top Category:</b> ${topCategory[0]} (₱${topCategory[1].toFixed(2)})
<br><br><b>Category Breakdown:</b>${categoryBreakdown.replace(/\n/g, "<br>")}
<br><br><b>📁 File Metadata:</b>
<br><b>File Size:</b> ${(fileStats.size / (1024 * 1024)).toFixed(3)} MB
<br><b>Created by:</b> ${CREATOR_NAME}
    `;

  return { summary: summaryHtml };
};

// -------------------------------------------------------------------
// 4. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  await initializeCsv();
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses, and **Gemini AI** will log them into your CSV file. Currency is assumed to be **Philippine Peso (₱)**.

**Example Input:**
"Lunch at Jollibee ₱185, Taxi to meeting 250, bought new pens 500."

Type /help for commands.

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithHTML(simpleMdToHtml(welcomeMessage));
});

bot.help((ctx) => {
  const helpMessage = `
📚 **Available Commands:**

* Send a message with your expenses (e.g., "Dinner 500, Gas 1200").
* \`/download_csv\`: Sends you the latest statistics summary and the CSV file.
* \`/start\`: Shows the welcome message.

Bot created by **${CREATOR_NAME}**.
    `;
  ctx.replyWithHTML(simpleMdToHtml(helpMessage));
});

// Handle text messages and save to CSV
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

    // 2. Write to CSV
    const csvWriter = createObjectCsvWriter({
      path: CSV_FILE,
      header: [
        { id: "date", title: "Date" },
        { id: "description", title: "Description" },
        { id: "amount", title: "Amount (PHP)" },
        { id: "category", title: "Category" },
      ],
      append: true,
    });

    await csvWriter.writeRecords(newRecords);

    // 3. Confirmation
    const total = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    ctx.reply(
      `✅ AI Saved ${newRecords.length} items to CSV. Total: ₱${total.toFixed(
        2
      )}`
    );
  } catch (error) {
    console.error("Error processing with Gemini:", error);
    ctx.reply("Error saving data. Check server logs.");
  }
});

// Command to download the CSV file and show statistics
bot.command("download_csv", async (ctx) => {
  try {
    if (!fs.existsSync(CSV_FILE)) {
      return ctx.reply("No expenses saved yet! The file doesn't exist.");
    }

    const { summary } = await getStats();

    // getStats now returns HTML
    await ctx.replyWithHTML(summary);

    await ctx.replyWithDocument({
      source: fs.createReadStream(CSV_FILE),
      filename: "my_expenses.csv",
    });
  } catch (error) {
    console.error("Error sending file or stats:", error);
    ctx.reply(
      "Could not generate statistics or send the file. Check server logs."
    );
  }
});

// -------------------------------------------------------------------
// 5. Start the Bot
// -------------------------------------------------------------------

initializeCsv();
bot.launch();
console.log("KwentaKo Bot (ESM) is running...");

// -------------------------------------------------------------------
// Simple HTTP health-check endpoint (no extra deps)
// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/ping")) {
    try {
      const exists = fs.existsSync(CSV_FILE);
      const stats = exists ? await fsPromises.stat(CSV_FILE) : null;

      const payload = {
        status: "ok",
        uptime_seconds: process.uptime(),
        csv_exists: exists,
        csv_size_bytes: stats ? stats.size : 0,
        port: Number(PORT),
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", message: String(e) }));
      return;
    }
  }

  // Not found for any other path
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "not_found" }));
});

server.listen(PORT, () => {
  console.log(`Health endpoint available at http://localhost:${PORT}/health`);
});

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
