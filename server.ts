import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { parse } from "csv-parse/sync";
import AdmZip from "adm-zip";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = 3000;

  // In-memory knowledge base
  let knowledgeBase: any[] = [];
  let currentDataset = "";

  // Kaggle API helper
  async function downloadKaggleDataset(datasetId: string) {
    const username = process.env.KAGGLE_USERNAME || "mahafujhossainmunna";
    const key = process.env.KAGGLE_KEY || "b9da1a2a709b1645d40f04ce00781f1b";
    
    if (!username || !key) {
      throw new Error("Kaggle credentials not found. Please set KAGGLE_USERNAME and KAGGLE_KEY in your environment.");
    }
    const auth = Buffer.from(`${username}:${key}`).toString("base64");

    const url = `https://www.kaggle.com/api/v1/datasets/download/${datasetId}`;
    console.log(`Downloading from Kaggle: ${url}`);
    
    let response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'node-fetch',
      },
      redirect: 'manual'
    });

    // Handle redirect (Kaggle redirected to storage bucket)
    if (response.status === 302 || response.status === 301) {
      const redirectUrl = response.headers.get('location');
      if (redirectUrl) {
        console.log(`Following redirect to: ${redirectUrl.split('?')[0]}...`);
        response = await fetch(redirectUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'node-fetch',
          }
        });
      }
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`Kaggle API Error Detail: ${text}`);
      throw new Error(`Kaggle API Error (${response.status}): ${text || response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    
    let kb: any[] = [];
    zipEntries.forEach((entry) => {
      if (entry.entryName.endsWith(".csv")) {
        const content = entry.getData().toString("utf8");
        try {
          const records = parse(content, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            trim: true
          });
          kb = kb.concat(records);
        } catch (e) {
          console.error(`Error parsing CSV entry ${entry.entryName}:`, e);
        }
      }
    });
    
    return kb;
  }

  app.get("/api/status", (req, res) => {
    res.json({ 
      trained: knowledgeBase.length > 0, 
      count: knowledgeBase.length,
      dataset: currentDataset 
    });
  });

  app.post("/api/train", async (req, res) => {
    const { datasetId } = req.body;
    if (!datasetId) return res.status(400).json({ error: "No dataset ID provided" });
    
    try {
      console.log(`Attempting to load Kaggle dataset: ${datasetId}`);
      const data = await downloadKaggleDataset(datasetId);
      knowledgeBase = data;
      currentDataset = datasetId;
      console.log(`Success! Loaded ${knowledgeBase.length} records.`);
      res.json({ success: true, count: knowledgeBase.length });
    } catch (error: any) {
      console.error("Training error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/query", (req, res) => {
    const { q } = req.body;
    if (!knowledgeBase.length) {
      return res.json({ context: "" });
    }
    
    const query = q.toLowerCase();
    const queryWords = query.split(/\W+/).filter((w: string) => w.length > 3);
    
    // Simple heuristic: count word matches
    const scored = knowledgeBase.map(row => {
      const text = JSON.stringify(row).toLowerCase();
      let score = 0;
      queryWords.forEach((word: string) => {
        if (text.includes(word)) score++;
      });
      return { row, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5); // Return top 5 relevant rows
      
    res.json({ 
      context: scored.map(s => JSON.stringify(s.row)).join("\n---\n"),
      matches: scored.length
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
