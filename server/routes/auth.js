const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

router.post("/register", async (req, res) => {
  const { companyName, name, email, password } = req.body;

  if (!companyName || !name || !email || !password) {
    return res.status(400).json({
      status: "error",
      message: "All fields are required",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      status: "error",
      message: "Password must be at least 8 characters",
    });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      status: "error",
      message: "Server authentication is not configured",
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const existingUser = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        status: "error",
        message: "An account with this email already exists",
      });
    }

    const companyResult = await client.query(
      "INSERT INTO companies (name) VALUES ($1) RETURNING id",
      [companyName.trim()]
    );

    const companyId = companyResult.rows[0].id;
    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await client.query(
      `INSERT INTO users (company_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, company_id, name, email, role`,
      [companyId, name.trim(), email.trim().toLowerCase(), passwordHash, "admin"]
    );

    await client.query("COMMIT");

    const user = userResult.rows[0];

    const token = jwt.sign(
      {
        id: user.id,
        companyId: user.company_id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.status(201).json({
      status: "success",
      message: "Company and admin account created successfully",
      token,
      user,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK");

    if (error.code === "23505") {
      return res.status(409).json({
        status: "error",
        message: "An account with this email already exists",
      });
    }

    console.error("Registration error:", error);

    res.status(500).json({
      status: "error",
      message: "Registration failed",
    });
  } finally {
    if (client) client.release();
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      status: "error",
      message: "Email and password are required",
    });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      status: "error",
      message: "Server authentication is not configured",
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, company_id, name, email, password_hash, role
       FROM users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        status: "error",
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        companyId: user.company_id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.status(200).json({
      status: "success",
      message: "Login successful",
      token,
      user: {
        id: user.id,
        company_id: user.company_id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      status: "error",
      message: "Login failed",
    });
  }
});

module.exports = router;
