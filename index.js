import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import 'dotenv/config'


const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("frostfit");
const users = database.collection("user");
const sellerProducts = database.collection("sellerProducts");
const customerOrders = database.collection("customerOrders");



app.get("/", (_req, res) => {
    res.send("Hello World!");
});

app.post("/seller-products", async (req, res) => {
    const productDetails = req.body;

    if (!productDetails || typeof productDetails !== "object" || Array.isArray(productDetails)) {
        return res.status(400).json({ message: "Request body must be a product object." });
    }

    if (typeof productDetails.sellerId !== "string" || !productDetails.sellerId.trim()) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    const newProduct = {
        ...productDetails,
        sellerId: productDetails.sellerId.trim(),
        createdAt: new Date(),
    };
    delete newProduct._id;

    try {
        const result = await sellerProducts.insertOne(newProduct);
        return res.status(201).json({
            message: "Seller product created successfully.",
            product: { ...newProduct, _id: result.insertedId },
        });
    } catch (err) {
        console.error("Failed to create seller product:", err);
        return res.status(500).json({ message: "Failed to create seller product." });
    }
});

app.get("/seller-products", async (_req, res) => {
    try {
        const products = await sellerProducts
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({ products });
    } catch (err) {
        console.error("Failed to fetch products:", err);
        return res.status(500).json({ message: "Failed to fetch products." });
    }
});

app.get("/seller-products/:sellerId", async (req, res) => {
    const sellerId = req.params.sellerId?.trim();

    if (!sellerId) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    try {
        const products = await sellerProducts
            .find({ sellerId })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({ products });
    } catch (err) {
        console.error("Failed to fetch seller products:", err);
        return res.status(500).json({ message: "Failed to fetch seller products." });
    }
});

app.delete("/seller-products/:productId", async (req, res) => {
    const productId = req.params.productId;
    const sellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

    if (!ObjectId.isValid(productId)) {
        return res.status(400).json({ message: "A valid productId is required." });
    }

    if (!sellerId) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    try {
        const result = await sellerProducts.deleteOne({
            _id: new ObjectId(productId),
            sellerId,
        });

        if (!result.deletedCount) {
            return res.status(404).json({ message: "Product not found." });
        }

        return res.status(200).json({ message: "Seller product deleted successfully." });
    } catch (err) {
        console.error("Failed to delete seller product:", err);
        return res.status(500).json({ message: "Failed to delete seller product." });
    }
});

app.patch("/seller-products/:productId", async (req, res) => {
    const productId = req.params.productId;
    const { sellerId, _id, createdAt, updatedAt, status, ...updates } = req.body ?? {};

    if (!ObjectId.isValid(productId)) {
        return res.status(400).json({ message: "A valid productId is required." });
    }

    if (typeof sellerId !== "string" || !sellerId.trim()) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    if (!Object.keys(updates).length) {
        return res.status(400).json({ message: "Provide at least one product field to update." });
    }

    try {
        const result = await sellerProducts.findOneAndUpdate(
            { _id: new ObjectId(productId), sellerId: sellerId.trim() },
            { $set: { ...updates, updatedAt: new Date() } },
            { returnDocument: "after" },
        );

        if (!result) {
            return res.status(404).json({ message: "Product not found." });
        }

        return res.status(200).json({ product: result });
    } catch (err) {
        console.error("Failed to update seller product:", err);
        return res.status(500).json({ message: "Failed to update seller product." });
    }
});

// GET /api/orders - Get all customer orders for the authenticated customer
app.get("/api/orders", async (req, res) => {
    const customerId = req.headers["x-customer-id"];
    if (!customerId || typeof customerId !== "string") {
        return res.status(401).json({ message: "Customer ID required." });
    }

    try {
        const orders = await customerOrders
            .find({ customerId })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            orders: orders.map((order) => ({
                ...order,
                _id: String(order._id),
            })),
        });
    } catch (err) {
        console.error("Failed to fetch orders:", err);
        return res.status(500).json({ message: "Failed to load orders." });
    }
});

// POST /api/orders - Create a new order
app.post("/api/orders", async (req, res) => {
    const customerId = req.headers["x-customer-id"];
    if (!customerId || typeof customerId !== "string") {
        return res.status(401).json({ message: "Customer ID required." });
    }

    const body = req.body ?? {};

    const {
        items,
        shippingAddress,
        paymentMethod,
    } = body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Items are required." });
    }

    if (!shippingAddress || typeof shippingAddress !== "object") {
        return res.status(400).json({ message: "Shipping address is required." });
    }

    const allowedPayments = new Set(["cod", "bkash", "nagad", "card"]);
    if (typeof paymentMethod !== "string" || !allowedPayments.has(paymentMethod.trim())) {
        return res.status(400).json({ message: "Valid payment method is required." });
    }

    const requiredFields = ["fullName", "phone", "address", "city"];
    for (const field of requiredFields) {
        if (
            typeof shippingAddress[field] !== "string" ||
            !shippingAddress[field].trim()
        ) {
            return res.status(400).json({ message: `${field} is required.` });
        }
    }

    const orderItems = items.map((item) => ({
        productId: item.productId || "",
        name: item.name || "Product",
        brand: item.brand || "FrostFit",
        sku: item.sku || "",
        thumbnail: item.thumbnail || "",
        unitPrice: Number(item.unitPrice || 0),
        size: item.size || "",
        color: item.color || "",
        quantity: Number(item.quantity || 1),
    }));

    const totalAmount = orderItems.reduce(
        (sum, item) => sum + item.unitPrice * item.quantity,
        0,
    );

    const now = new Date();
    const newOrder = {
        customerId,
        customerName: shippingAddress.fullName.trim(),
        customerEmail: shippingAddress.email || "",
        items: orderItems,
        shippingAddress: {
            fullName: shippingAddress.fullName.trim(),
            phone: shippingAddress.phone.trim(),
            address: shippingAddress.address.trim(),
            city: shippingAddress.city.trim(),
            postalCode: shippingAddress.postalCode || "",
            note: shippingAddress.note || "",
        },
        paymentMethod: paymentMethod.trim(),
        totalAmount,
        status: "pending",
        createdAt: now,
        updatedAt: now,
    };

    try {
        const result = await customerOrders.insertOne(newOrder);
        return res.status(201).json({
            message: "Order placed successfully.",
            order: { ...newOrder, _id: String(result.insertedId) },
        });
    } catch (err) {
        console.error("Failed to place order:", err);
        return res.status(500).json({ message: "Failed to place order." });
    }
});

// PATCH /api/orders/:orderId - Cancel an order
app.patch("/api/orders/:orderId", async (req, res) => {
    const customerId = req.headers["x-customer-id"];
    if (!customerId || typeof customerId !== "string") {
        return res.status(401).json({ message: "Customer ID required." });
    }

    const orderId = req.params.orderId;
    const body = req.body ?? {};
    const status = typeof body.status === "string" ? body.status.trim() : "";

    if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ message: "A valid orderId is required." });
    }

    if (status !== "cancelled") {
        return res.status(400).json({ message: "Only cancellation is supported." });
    }

    try {
        const order = await customerOrders.findOne({
            _id: new ObjectId(orderId),
            customerId,
        });

        if (!order) {
            return res.status(404).json({ message: "Order not found." });
        }

        const nonCancellableStatuses = new Set([
            "delivered",
            "cancelled",
            "shipped",
        ]);

        if (nonCancellableStatuses.has(order.status)) {
            return res.status(400).json({
                message: `Orders with status "${order.status}" cannot be cancelled.`,
            });
        }

        const result = await customerOrders.updateOne(
            { _id: new ObjectId(orderId), customerId },
            { $set: { status: "cancelled", updatedAt: new Date() } },
        );

        if (!result.modifiedCount) {
            return res.status(400).json({ message: "Order could not be cancelled." });
        }

        return res.status(200).json({ message: "Order cancelled successfully." });
    } catch (err) {
        console.error("Failed to cancel order:", err);
        return res.status(500).json({ message: "Failed to cancel order." });
    }
});

// DELETE /api/orders/:orderId - Delete an order
app.delete("/api/orders/:orderId", async (req, res) => {
    const customerId = req.headers["x-customer-id"];
    if (!customerId || typeof customerId !== "string") {
        return res.status(401).json({ message: "Customer ID required." });
    }

    const orderId = req.params.orderId;

    if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ message: "A valid orderId is required." });
    }

    try {
        const result = await customerOrders.deleteOne({
            _id: new ObjectId(orderId),
            customerId,
        });

        if (!result.deletedCount) {
            return res.status(404).json({ message: "Order not found." });
        }

        return res.status(200).json({ message: "Order deleted successfully." });
    } catch (err) {
        console.error("Failed to delete order:", err);
        return res.status(500).json({ message: "Failed to delete order." });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
