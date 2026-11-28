const express = require("express");
const app = express();
require("dotenv").config();
const pool = require("./config/db");
const authMiddleware = require("./middleware/authMiddleware");
const authorizeRoles = require("./middleware/authorizeRoles");

app.use(express.json());

const cors = require("cors");
app.use(cors());

app.use("/api/auth", require("./routes/auth"));

// Register protected product management routes
app.use("/api/products", require("./routes/products"));
app.use("/api/stock", require("./routes/stock"));
app.use("/api/customers", require("./routes/customers"));

const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.json({ message: "Welcome to StockFlow API" });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "StockFlow API is healthy",
  });
});

app.get("/api/protected", authMiddleware, (req, res) => {
  res.status(200).json({
    status: "success",
    message: "You have accessed a protected route",
    user: req.user,
  });
});

app.get(
  "/api/admin-only",
  authMiddleware,
  authorizeRoles("admin"),
  (req, res) => {
    res.status(200).json({
      status: "success",
      message: "Welcome Admin. You have access to this route.",
    });
  }
);

app.get(
  "/api/manager-only",
  authMiddleware,
  authorizeRoles("manager"),
  (req, res) => {
    res.status(200).json({
      status: "success",
      message: "Welcome Manager. You have access to this route.",
    });
  }
);

app.get(
  "/api/staff-only",
  authMiddleware,
  authorizeRoles("staff"),
  (req, res) => {
    res.status(200).json({
      status: "success",
      message: "Welcome Staff. You have access to this route.",
    });
  }
);

app.get("/api/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.status(200).json({
      status: "success",
      message: "Database connected successfully",
      time: result.rows[0].now,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Database connection failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`StockFlow server is running on port ${PORT}`);
});

