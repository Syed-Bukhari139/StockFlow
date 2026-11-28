const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const pool = require("../config/db");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/authorizeRoles");

router.use(authMiddleware);

// Safely roll back a transaction
async function rollbackTransaction(client) {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("Transaction rollback error:", error);
  }
}

// Create a new order
router.post(
  "/",
  authorizeRoles("admin", "manager", "staff"),
  async (req, res) => {
    const { customerId, items, notes } = req.body;

    if (!Number.isSafeInteger(customerId) || customerId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "A valid customer ID is required",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Order must contain at least one item",
      });
    }

    if (
      notes !== undefined &&
      notes !== null &&
      typeof notes !== "string"
    ) {
      return res.status(400).json({
        status: "error",
        message: "Notes must be a string",
      });
    }

    const productIds = [];

    for (const item of items) {
      if (
        !item ||
        !Number.isSafeInteger(item.productId) ||
        item.productId <= 0
      ) {
        return res.status(400).json({
          status: "error",
          message: "Each item must have a valid product ID",
        });
      }

      if (
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0
      ) {
        return res.status(400).json({
          status: "error",
          message: "Each item must have a positive whole-number quantity",
        });
      }

      productIds.push(item.productId);
    }

    if (new Set(productIds).size !== productIds.length) {
      return res.status(400).json({
        status: "error",
        message: "Duplicate products are not allowed in an order",
      });
    }

    let client;
    let transactionStarted = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      // Verify customer belongs to the user's company
      const customerResult = await client.query(
        `SELECT id
         FROM customers
         WHERE id = $1 AND company_id = $2`,
        [customerId, req.user.companyId]
      );

      if (customerResult.rows.length === 0) {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(404).json({
          status: "error",
          message: "Customer not found",
        });
      }

      // Lock products and verify company ownership
      const productsResult = await client.query(
        `SELECT id, name, sku, price, quantity
         FROM products
         WHERE id = ANY($1::bigint[])
         AND company_id = $2
         ORDER BY id
         FOR UPDATE`,
        [productIds, req.user.companyId]
      );

      if (productsResult.rows.length !== productIds.length) {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(404).json({
          status: "error",
          message: "One or more products were not found",
        });
      }

      const productsMap = new Map(
        productsResult.rows.map((product) => [
          Number(product.id),
          product,
        ])
      );

      // Check stock and calculate order total in pence
      let totalCents = 0;
      const orderItems = [];

      for (const item of items) {
        const product = productsMap.get(item.productId);

        if (Number(product.quantity) < item.quantity) {
          await rollbackTransaction(client);
          transactionStarted = false;

          return res.status(400).json({
            status: "error",
            message: `Insufficient stock for ${product.name}`,
          });
        }

        const unitPriceCents = Math.round(
          Number(product.price) * 100
        );

        const subtotalCents = unitPriceCents * item.quantity;

        if (
          !Number.isSafeInteger(subtotalCents) ||
          !Number.isSafeInteger(totalCents + subtotalCents)
        ) {
          await rollbackTransaction(client);
          transactionStarted = false;

          return res.status(400).json({
            status: "error",
            message: "Order total is too large",
          });
        }

        totalCents += subtotalCents;

        orderItems.push({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: (unitPriceCents / 100).toFixed(2),
          subtotal: (subtotalCents / 100).toFixed(2),
        });
      }

      const totalAmount = (totalCents / 100).toFixed(2);
      const orderNumber = `ORD-${crypto.randomUUID()}`;

      // Create order
      const orderResult = await client.query(
        `INSERT INTO orders (
          company_id,
          customer_id,
          user_id,
          order_number,
          status,
          total_amount,
          notes
        )
        VALUES ($1, $2, $3, $4, 'pending', $5, $6)
        RETURNING *`,
        [
          req.user.companyId,
          customerId,
          req.user.id,
          orderNumber,
          totalAmount,
          notes && notes.trim() ? notes.trim() : null,
        ]
      );

      const order = orderResult.rows[0];

      // Insert items, deduct stock and record movements
      for (const item of orderItems) {
        await client.query(
          `INSERT INTO order_items (
            order_id,
            product_id,
            quantity,
            unit_price,
            subtotal
          )
          VALUES ($1, $2, $3, $4, $5)`,
          [
            order.id,
            item.productId,
            item.quantity,
            item.unitPrice,
            item.subtotal,
          ]
        );

        // Deduct stock and verify that the update succeeded
        const stockResult = await client.query(
          `UPDATE products
           SET quantity = quantity - $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2
           AND company_id = $3
           AND quantity >= $1
           RETURNING id`,
          [
            item.quantity,
            item.productId,
            req.user.companyId,
          ]
        );

        if (stockResult.rowCount !== 1) {
          throw new Error(
            `Stock update failed for product ${item.productId}`
          );
        }

        await client.query(
          `INSERT INTO stock_movements (
            company_id,
            product_id,
            user_id,
            movement_type,
            quantity_change,
            reason
          )
          VALUES ($1, $2, $3, 'order', $4, $5)`,
          [
            req.user.companyId,
            item.productId,
            req.user.id,
            -item.quantity,
            `Order ${orderNumber}`,
          ]
        );
      }

      // Record audit log
      await client.query(
        `INSERT INTO audit_logs (
          company_id,
          user_id,
          action,
          entity_type,
          entity_id,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user.companyId,
          req.user.id,
          "CREATE_ORDER",
          "order",
          order.id,
          JSON.stringify({ orderNumber, totalAmount }),
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        status: "success",
        message: "Order created successfully",
        order,
        items: orderItems,
      });
    } catch (error) {
      if (client && transactionStarted) {
        await rollbackTransaction(client);
      }

      console.error("Create order error:", error);

      return res.status(500).json({
        status: "error",
        message: "Failed to create order",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// Get all orders for the company
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        o.id,
        o.order_number,
        o.status,
        o.total_amount,
        o.notes,
        o.created_at,
        c.name AS customer_name,
        COUNT(oi.id)::INTEGER AS item_count
       FROM orders o
       LEFT JOIN customers c
         ON o.customer_id = c.id
         AND c.company_id = o.company_id
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.company_id = $1
       GROUP BY o.id, c.name
       ORDER BY o.created_at DESC`,
      [req.user.companyId]
    );

    return res.json({
      status: "success",
      count: result.rows.length,
      orders: result.rows,
    });
  } catch (error) {
    console.error("Get orders error:", error);

    return res.status(500).json({
      status: "error",
      message: "Failed to retrieve orders",
    });
  }
});

// Get one order with its items
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({
      status: "error",
      message: "Invalid order ID",
    });
  }

  try {
    const orderResult = await pool.query(
      `SELECT
        o.*,
        c.name AS customer_name,
        c.email AS customer_email,
        u.name AS created_by
       FROM orders o
       LEFT JOIN customers c
         ON o.customer_id = c.id
         AND c.company_id = o.company_id
       LEFT JOIN users u
         ON o.user_id = u.id
         AND u.company_id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2`,
      [id, req.user.companyId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Order not found",
      });
    }

    const itemsResult = await pool.query(
      `SELECT
        oi.id,
        oi.product_id,
        p.name AS product_name,
        p.sku,
        oi.quantity,
        oi.unit_price,
        oi.subtotal
       FROM order_items oi
       JOIN products p
         ON oi.product_id = p.id
         AND p.company_id = $2
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [id, req.user.companyId]
    );

    return res.json({
      status: "success",
      order: orderResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error("Get order error:", error);

    return res.status(500).json({
      status: "error",
      message: "Failed to retrieve order",
    });
  }
});

// Update order status
router.patch(
  "/:id/status",
  authorizeRoles("admin", "manager"),
  async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid order ID",
      });
    }

    if (!["processing", "completed"].includes(status)) {
      return res.status(400).json({
        status: "error",
        message: "Status must be processing or completed",
      });
    }

    let client;
    let transactionStarted = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      // Lock the order before checking its current status
      const orderCheck = await client.query(
        `SELECT *
         FROM orders
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [id, req.user.companyId]
      );

      if (orderCheck.rows.length === 0) {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(404).json({
          status: "error",
          message: "Order not found",
        });
      }

      const currentOrder = orderCheck.rows[0];
      const previousStatus = currentOrder.status;

      const validTransition =
        (previousStatus === "pending" && status === "processing") ||
        (previousStatus === "processing" && status === "completed");

      if (!validTransition) {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(400).json({
          status: "error",
          message: "Invalid order status transition",
        });
      }

      const result = await client.query(
        `UPDATE orders
         SET status = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [status, id, req.user.companyId]
      );

      if (result.rowCount !== 1) {
        throw new Error("Order status update failed");
      }

      // Record status change in audit log
      await client.query(
        `INSERT INTO audit_logs (
          company_id,
          user_id,
          action,
          entity_type,
          entity_id,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user.companyId,
          req.user.id,
          "UPDATE_ORDER_STATUS",
          "order",
          id,
          JSON.stringify({
            orderNumber: currentOrder.order_number,
            previousStatus,
            newStatus: status,
          }),
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        status: "success",
        message: "Order status updated successfully",
        order: result.rows[0],
      });
    } catch (error) {
      if (client && transactionStarted) {
        await rollbackTransaction(client);
      }

      console.error("Update order status error:", error);

      return res.status(500).json({
        status: "error",
        message: "Failed to update order status",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// Cancel an order and restore stock
router.patch(
  "/:id/cancel",
  authorizeRoles("admin", "manager"),
  async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid order ID",
      });
    }

    let client;
    let transactionStarted = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const orderResult = await client.query(
        `SELECT *
         FROM orders
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [id, req.user.companyId]
      );

      if (orderResult.rows.length === 0) {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(404).json({
          status: "error",
          message: "Order not found",
        });
      }

      const order = orderResult.rows[0];

      if (order.status === "cancelled") {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(400).json({
          status: "error",
          message: "Order is already cancelled",
        });
      }

      if (order.status === "completed") {
        await rollbackTransaction(client);
        transactionStarted = false;

        return res.status(400).json({
          status: "error",
          message: "Completed orders cannot be cancelled",
        });
      }

      const itemsResult = await client.query(
        `SELECT product_id, quantity
         FROM order_items
         WHERE order_id = $1`,
        [id]
      );

      for (const item of itemsResult.rows) {
        // Restore stock and verify that the update succeeded
        const stockResult = await client.query(
          `UPDATE products
           SET quantity = quantity + $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND company_id = $3
           RETURNING id`,
          [
            item.quantity,
            item.product_id,
            req.user.companyId,
          ]
        );

        if (stockResult.rowCount !== 1) {
          throw new Error(
            `Stock restoration failed for product ${item.product_id}`
          );
        }

        await client.query(
          `INSERT INTO stock_movements (
            company_id,
            product_id,
            user_id,
            movement_type,
            quantity_change,
            reason
          )
          VALUES ($1, $2, $3, 'cancellation', $4, $5)`,
          [
            req.user.companyId,
            item.product_id,
            req.user.id,
            item.quantity,
            `Cancellation of order ${order.order_number}`,
          ]
        );
      }

      const updatedOrder = await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, req.user.companyId]
      );

      if (updatedOrder.rowCount !== 1) {
        throw new Error("Order cancellation update failed");
      }

      // Record cancellation in audit log
      await client.query(
        `INSERT INTO audit_logs (
          company_id,
          user_id,
          action,
          entity_type,
          entity_id,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user.companyId,
          req.user.id,
          "CANCEL_ORDER",
          "order",
          id,
          JSON.stringify({
            orderNumber: order.order_number,
            previousStatus: order.status,
            newStatus: "cancelled",
          }),
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.json({
        status: "success",
        message: "Order cancelled and stock restored successfully",
        order: updatedOrder.rows[0],
      });
    } catch (error) {
      if (client && transactionStarted) {
        await rollbackTransaction(client);
      }

      console.error("Cancel order error:", error);

      return res.status(500).json({
        status: "error",
        message: "Failed to cancel order",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

module.exports = router;
