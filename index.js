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
const productReviews = database.collection("productReviews");
const customerAddresses = database.collection("customerAddresses");
const customerSavedItems = database.collection("customerSavedItems");

function requireCustomerId(req, res, next) {
    const customerId = req.get("x-customer-id")?.trim();
    if (!customerId) {
        return res.status(401).json({ message: "Customer ID required." });
    }
    req.customerId = customerId;
    return next();
}

function normalizeAddress(body = {}) {
    return {
        fullName: typeof body.fullName === "string" ? body.fullName.trim() : "",
        phone: typeof body.phone === "string" ? body.phone.trim() : "",
        address: typeof body.address === "string" ? body.address.trim() : "",
        city: typeof body.city === "string" ? body.city.trim() : "",
        postalCode: typeof body.postalCode === "string" ? body.postalCode.trim() : "",
        note: typeof body.note === "string" ? body.note.trim() : "",
    };
}

function isValidAddress(address) {
    return Boolean(address.fullName && address.phone && address.address && address.city)
        && address.fullName.length <= 120
        && address.phone.length <= 40
        && address.address.length <= 300
        && address.city.length <= 100
        && address.postalCode.length <= 24
        && address.note.length <= 500;
}

function profileUserFilter(customerId) {
    const alternatives = [{ _id: customerId }, { id: customerId }];
    if (ObjectId.isValid(customerId)) alternatives.unshift({ _id: new ObjectId(customerId) });
    return { $or: alternatives };
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nonEmptyStrings(values) {
    return values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}



app.get("/", (_req, res) => {
    res.send("Hello World!");
});

// GET /products - Search and filter products for the storefront.
app.get("/products", async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const season = typeof req.query.season === "string" ? req.query.season.trim() : "";
        const gender = typeof req.query.gender === "string" ? req.query.gender.trim() : "";
        const size = typeof req.query.size === "string" ? req.query.size.trim() : "";
        const inStock = req.query.inStock === "true";
        const sort = typeof req.query.sort === "string" ? req.query.sort.trim() : "newest";
        const baseFilter = {};
        if (season && season.toLowerCase() !== "all") {
            baseFilter["details.season"] = { $regex: new RegExp(`^${escapeRegex(season)}$`, "i") };
        }

        const queryFilter = { ...baseFilter };
        if (q) {
            const pattern = new RegExp(escapeRegex(q), "i");
            queryFilter.$or = [
                { name: pattern }, { brand: pattern }, { sku: pattern },
                { description: pattern }, { "details.material": pattern },
            ];
        }
        if (gender && gender.toLowerCase() !== "all") {
            queryFilter["details.gender"] = { $regex: new RegExp(`^${escapeRegex(gender)}$`, "i") };
        }
        if (size && size.toLowerCase() !== "all") {
            queryFilter.variants = {
                $elemMatch: {
                    size: { $regex: new RegExp(`^${escapeRegex(size)}$`, "i") },
                    ...(inStock ? { stock: { $gt: 0 } } : {}),
                },
            };
        } else if (inStock) {
            queryFilter["variants.stock"] = { $gt: 0 };
        }

        const sortStage = sort === "price-asc"
            ? { _effectivePrice: 1, createdAt: -1 }
            : sort === "price-desc"
                ? { _effectivePrice: -1, createdAt: -1 }
                : { createdAt: -1 };
        const [products, totalCount, rawSeasons, rawGenders, rawSizes] = await Promise.all([
            sellerProducts.aggregate([
                { $match: queryFilter },
                { $addFields: { _effectivePrice: {
                    $cond: [
                        { $and: [{ $gt: ["$pricing.discountPrice", 0] }, { $lt: ["$pricing.discountPrice", "$pricing.price"] }] },
                        "$pricing.discountPrice",
                        { $ifNull: ["$pricing.price", 0] },
                    ],
                } } },
                { $sort: sortStage },
                { $project: { _effectivePrice: 0 } },
            ]).toArray(),
            sellerProducts.countDocuments(queryFilter),
            sellerProducts.distinct("details.season", baseFilter),
            sellerProducts.distinct("details.gender", baseFilter),
            sellerProducts.distinct("variants.size", baseFilter),
        ]);
        return res.status(200).json({
            products: products.map((product) => ({ ...product, _id: String(product._id) })),
            totalCount,
            facets: {
                seasons: [...new Set(nonEmptyStrings(rawSeasons))].sort((a, b) => a.localeCompare(b)),
                genders: [...new Set(nonEmptyStrings(rawGenders))].sort((a, b) => a.localeCompare(b)),
                sizes: [...new Set(nonEmptyStrings(rawSizes))],
            },
        });
    } catch (err) {
        console.error("Failed to query products:", err);
        return res.status(500).json({ message: "Failed to load products from API." });
    }
});

// GET /customer-addresses - List addresses belonging to the customer ID header
app.get("/customer-addresses", requireCustomerId, async (req, res) => {
    try {
        const addresses = await customerAddresses
            .find({ customerId: req.customerId })
            .sort({ isDefault: -1, updatedAt: -1 })
            .toArray();
        return res.status(200).json({
            addresses: addresses.map((address) => ({ ...address, _id: String(address._id) })),
        });
    } catch (err) {
        console.error("Failed to fetch customer addresses:", err);
        return res.status(500).json({ message: "Failed to load addresses." });
    }
});

// POST /customer-addresses - Save an address for the customer ID header
app.post("/customer-addresses", requireCustomerId, async (req, res) => {
    const address = normalizeAddress(req.body);
    if (!isValidAddress(address)) {
        return res.status(400).json({ message: "Enter a name, phone, street address, and city. Keep each field within its limit." });
    }

    try {
        const currentCount = await customerAddresses.countDocuments({ customerId: req.customerId });
        const isDefault = req.body?.isDefault === true || currentCount === 0;
        if (isDefault) {
            await customerAddresses.updateMany({ customerId: req.customerId }, { $set: { isDefault: false } });
        }

        const now = new Date();
        const document = {
            customerId: req.customerId,
            ...address,
            isDefault,
            createdAt: now,
            updatedAt: now,
        };
        const result = await customerAddresses.insertOne(document);
        return res.status(201).json({
            message: "Address saved.",
            address: { ...document, _id: String(result.insertedId) },
        });
    } catch (err) {
        console.error("Failed to save customer address:", err);
        return res.status(500).json({ message: "Failed to save address." });
    }
});

// PATCH /customer-addresses - Update an owned address or make it the default
app.patch("/customer-addresses", requireCustomerId, async (req, res) => {
    const addressId = typeof req.body?.addressId === "string" ? req.body.addressId : "";
    if (!ObjectId.isValid(addressId)) {
        return res.status(400).json({ message: "A valid addressId is required." });
    }

    const address = normalizeAddress(req.body);
    if (!isValidAddress(address)) {
        return res.status(400).json({ message: "Enter a name, phone, street address, and city. Keep each field within its limit." });
    }

    try {
        const filter = { _id: new ObjectId(addressId), customerId: req.customerId };
        const existing = await customerAddresses.findOne(filter);
        if (!existing) return res.status(404).json({ message: "Address not found." });

        const isDefault = req.body?.isDefault === true;
        if (isDefault) {
            await customerAddresses.updateMany({ customerId: req.customerId }, { $set: { isDefault: false } });
        }

        await customerAddresses.updateOne(filter, {
            $set: { ...address, isDefault, updatedAt: new Date() },
        });
        const updatedAddress = await customerAddresses.findOne(filter);
        if (!updatedAddress) return res.status(404).json({ message: "Address not found." });
        return res.status(200).json({
            message: "Address updated.",
            address: { ...updatedAddress, _id: String(updatedAddress._id) },
        });
    } catch (err) {
        console.error("Failed to update customer address:", err);
        return res.status(500).json({ message: "Failed to update address." });
    }
});

// DELETE /customer-addresses/:addressId - Delete an address owned by this customer
app.delete("/customer-addresses/:addressId", requireCustomerId, async (req, res) => {
    const { addressId } = req.params;
    if (!ObjectId.isValid(addressId)) {
        return res.status(400).json({ message: "A valid addressId is required." });
    }

    try {
        const filter = { _id: new ObjectId(addressId), customerId: req.customerId };
        const result = await customerAddresses.findOneAndDelete(filter);
        if (!result) return res.status(404).json({ message: "Address not found." });

        if (result.isDefault === true) {
            const nextAddress = await customerAddresses
                .find({ customerId: req.customerId })
                .sort({ updatedAt: -1 })
                .limit(1)
                .next();
            if (nextAddress) {
                await customerAddresses.updateOne(
                    { _id: nextAddress._id, customerId: req.customerId },
                    { $set: { isDefault: true, updatedAt: new Date() } },
                );
            }
        }

        return res.status(200).json({ message: "Address removed." });
    } catch (err) {
        console.error("Failed to remove customer address:", err);
        return res.status(500).json({ message: "Failed to remove address." });
    }
});

// Customer profile. Email and role are read-only; name, phone, and image can be updated.
app.get("/api/customer/profile", requireCustomerId, async (req, res) => {
    try {
        const user = await users.findOne(profileUserFilter(req.customerId), {
            projection: { name: 1, email: 1, image: 1, phone: 1, emailVerified: 1, role: 1 },
        });
        if (!user) return res.status(404).json({ message: "Customer profile not found." });
        return res.status(200).json({
            profile: {
                customerId: req.customerId,
                name: String(user.name ?? ""),
                email: String(user.email ?? ""),
                phone: String(user.phone ?? ""),
                image: typeof user.image === "string" ? user.image : "",
                emailVerified: user.emailVerified === true,
                role: String(user.role ?? "customer"),
            },
        });
    } catch (err) {
        console.error("Failed to load customer profile:", err);
        return res.status(500).json({ message: "Failed to load profile." });
    }
});

app.patch("/api/customer/profile", requireCustomerId, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const image = typeof req.body?.image === "string" ? req.body.image.trim() : "";
    if (name.length < 2 || name.length > 100) {
        return res.status(400).json({ message: "Name must be between 2 and 100 characters." });
    }
    if (!phone || phone.length > 40) {
        return res.status(400).json({ message: "Enter a phone number no longer than 40 characters." });
    }
    if (image.length > 2048) {
        return res.status(400).json({ message: "Profile image URL is too long." });
    }
    if (image) {
        try {
            const imageUrl = new URL(image);
            if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error("Unsupported protocol");
        } catch {
            return res.status(400).json({ message: "Profile image must be a valid http or https URL." });
        }
    }

    try {
        const filter = profileUserFilter(req.customerId);
        const user = await users.findOne(filter, { projection: { _id: 1 } });
        if (!user) return res.status(404).json({ message: "Customer profile not found." });
        await users.updateOne(filter, {
            $set: { name, phone, image, updatedAt: new Date() },
        });
        return res.status(200).json({ message: "Profile updated successfully." });
    } catch (err) {
        console.error("Failed to update customer profile:", err);
        return res.status(500).json({ message: "Failed to update profile." });
    }
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

// Customer saved items
app.get("/customer-saved-items", requireCustomerId, async (req, res) => {
    try {
        const items = await customerSavedItems.find({ userId: req.customerId }).sort({ updatedAt: -1 }).toArray();
        return res.status(200).json({ items: items.map((item) => ({ ...item, _id: String(item._id) })) });
    } catch (err) {
        console.error("Failed to fetch customer saved items:", err);
        return res.status(500).json({ message: "Failed to load saved items." });
    }
});

app.post("/customer-saved-items", requireCustomerId, async (req, res) => {
    const body = req.body ?? {};
    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const brand = typeof body.brand === "string" ? body.brand.trim() : "";
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    const thumbnail = typeof body.thumbnail === "string" ? body.thumbnail.trim() : "";
    const size = typeof body.size === "string" ? body.size.trim() : "";
    const color = typeof body.color === "string" ? body.color.trim() : "";
    const unitPrice = Number(body.unitPrice);
    const quantity = Number(body.quantity);
    if (!productId || !name) return res.status(400).json({ message: "productId and name are required." });
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(400).json({ message: "Valid unitPrice is required." });
    if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ message: "Quantity must be at least 1." });

    try {
        const now = new Date();
        const item = await customerSavedItems.findOneAndUpdate(
            { userId: req.customerId, productId, size, color },
            {
                $set: { name, brand, sku, thumbnail, unitPrice, quantity, updatedAt: now },
                $setOnInsert: { userId: req.customerId, productId, size, color, createdAt: now },
            },
            { upsert: true, returnDocument: "after" },
        );
        if (!item) return res.status(500).json({ message: "Could not save item." });
        return res.status(201).json({ message: "Item saved for order.", item: { ...item, _id: String(item._id) } });
    } catch (err) {
        console.error("Failed to save customer item:", err);
        return res.status(500).json({ message: "Failed to save item." });
    }
});

app.delete("/customer-saved-items/:itemId", requireCustomerId, async (req, res) => {
    if (!ObjectId.isValid(req.params.itemId)) return res.status(400).json({ message: "A valid itemId is required." });
    try {
        const result = await customerSavedItems.deleteOne({ _id: new ObjectId(req.params.itemId), userId: req.customerId });
        if (!result.deletedCount) return res.status(404).json({ message: "Saved item not found." });
        return res.status(200).json({ message: "Saved item removed." });
    } catch (err) {
        console.error("Failed to remove saved item:", err);
        return res.status(500).json({ message: "Failed to remove saved item." });
    }
});

// Seller order management
app.get("/api/seller/orders", async (req, res) => {
    const sellerId = req.get("x-seller-id")?.trim();
    if (!sellerId) return res.status(401).json({ message: "Seller ID required." });
    try {
        const sellerItems = await sellerProducts.find({ sellerId }, { projection: { _id: 1 } }).toArray();
        const productIds = sellerItems.map(({ _id }) => String(_id));
        if (!productIds.length) return res.status(200).json({ orders: [] });
        const rawOrders = await customerOrders.find({ "items.productId": { $in: productIds } }).sort({ createdAt: -1 }).toArray();
        const orders = rawOrders.flatMap((order) => {
            const items = Array.isArray(order.items) ? order.items.filter((item) => productIds.includes(String(item.productId))) : [];
            if (!items.length) return [];
            return [{
                _id: String(order._id),
                customerName: String(order.customerName ?? order.shippingAddress?.fullName ?? "Customer"),
                customerEmail: String(order.customerEmail ?? ""),
                items,
                totalAmount: items.reduce((sum, item) => sum + Number(item.unitPrice ?? 0) * Number(item.quantity ?? 1), 0),
                status: String(order.status ?? "pending"),
                trackingUrl: typeof order.trackingUrl === "string" ? order.trackingUrl : "",
                returnRequest: order.returnRequest ?? null,
                createdAt: order.createdAt,
                paymentMethod: String(order.paymentMethod ?? ""),
                shippingAddress: order.shippingAddress ?? null,
            }];
        });
        return res.status(200).json({ orders });
    } catch (err) {
        console.error("Failed to fetch seller orders:", err);
        return res.status(500).json({ message: "Failed to load seller orders." });
    }
});

app.patch("/api/seller/orders", async (req, res) => {
    const sellerId = req.get("x-seller-id")?.trim();
    if (!sellerId) return res.status(401).json({ message: "Seller ID required." });
    const { orderId, status, trackingUrl, returnStatus } = req.body ?? {};
    if (typeof orderId !== "string" || !ObjectId.isValid(orderId)) return res.status(400).json({ message: "A valid orderId is required." });
    if (status !== undefined && !["confirmed", "rejected", "delivered"].includes(status)) return res.status(400).json({ message: "Status must be confirmed, rejected, or delivered." });
    if (returnStatus !== undefined && !["approved", "rejected", "refunded"].includes(returnStatus)) return res.status(400).json({ message: "Return status must be approved, rejected, or refunded." });
    if (status === undefined && trackingUrl === undefined && returnStatus === undefined) return res.status(400).json({ message: "Provide an order update." });

    let normalizedTrackingUrl;
    if (trackingUrl !== undefined) {
        if (typeof trackingUrl !== "string") return res.status(400).json({ message: "Tracking link must be a URL." });
        const value = trackingUrl.trim();
        if (value) {
            try {
                const url = new URL(value);
                if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported protocol");
                normalizedTrackingUrl = url.toString();
            } catch {
                return res.status(400).json({ message: "Enter a valid tracking URL starting with http:// or https://." });
            }
        } else normalizedTrackingUrl = null;
    }

    try {
        const sellerItems = await sellerProducts.find({ sellerId }, { projection: { _id: 1 } }).toArray();
        const productIds = sellerItems.map(({ _id }) => String(_id));
        if (!productIds.length) return res.status(404).json({ message: "No products found for this seller." });
        const allowedCurrentStatuses = status === "delivered" ? ["confirmed"] : status ? ["pending", "new"] : null;
        const filter = {
            _id: new ObjectId(orderId),
            status: allowedCurrentStatuses ? { $in: allowedCurrentStatuses } : { $ne: "rejected" },
            "items.productId": { $in: productIds },
        };
        const setFields = { updatedAt: new Date() };
        if (status !== undefined) setFields.status = status;
        if (returnStatus !== undefined) {
            setFields["returnRequest.status"] = returnStatus;
            setFields["returnRequest.updatedAt"] = new Date();
        }
        if (typeof normalizedTrackingUrl === "string") setFields.trackingUrl = normalizedTrackingUrl;
        const filterWithReturn = returnStatus === undefined ? filter : { ...filter, "returnRequest.status": "requested" };
        const update = { $set: setFields };
        if (normalizedTrackingUrl === null) update.$unset = { trackingUrl: "" };
        const result = await customerOrders.updateOne(filterWithReturn, update);
        if (!result.matchedCount) {
            const exists = await customerOrders.findOne({ _id: new ObjectId(orderId), "items.productId": { $in: productIds } });
            return res.status(exists ? 409 : 404).json({ message: exists ? "This order has already been processed." : "Order not found for your products." });
        }
        return res.status(200).json({ message: returnStatus ? "Return request updated." : status === undefined ? "Tracking link saved." : "Order updated.", status, returnStatus, trackingUrl: normalizedTrackingUrl ?? null });
    } catch (err) {
        console.error("Failed to update seller order:", err);
        return res.status(500).json({ message: "Failed to update order status." });
    }
});

// GET /api/orders - Get all customer orders for the customer ID header
app.get("/api/orders", requireCustomerId, async (req, res) => {
    try {
        const orders = await customerOrders
            .find({ $or: [{ customerId: req.customerId }, { userId: req.customerId }] })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            orders: orders.map((order) => ({
                ...order,
                _id: String(order._id),
                customerId: String(order.customerId ?? order.userId ?? ""),
            })),
        });
    } catch (err) {
        console.error("Failed to fetch orders:", err);
        return res.status(500).json({ message: "Failed to load orders." });
    }
});

// POST /api/orders - Create a new order
app.post("/api/orders", requireCustomerId, async (req, res) => {
    const body = req.body ?? {};
    const rawIds = Array.isArray(body.savedItemIds) ? body.savedItemIds : [];
    const savedItemIds = rawIds.filter((id) => typeof id === "string");
    if (!savedItemIds.length || savedItemIds.length !== rawIds.length || savedItemIds.some((id) => !ObjectId.isValid(id)) || new Set(savedItemIds).size !== savedItemIds.length) {
        return res.status(400).json({ message: "Select at least one saved item to order." });
    }

    const shippingAddress = body.shippingAddress;
    const paymentMethod = body.paymentMethod;

    if (!shippingAddress || typeof shippingAddress !== "object") {
        return res.status(400).json({ message: "Shipping address is required." });
    }

    const allowedPayments = new Set(["cod", "bkash", "nagad", "card"]);
    if (typeof paymentMethod !== "string" || !allowedPayments.has(paymentMethod.trim())) {
        return res.status(400).json({ message: "Please select a valid payment method." });
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

    try {
        const selectedItems = await customerSavedItems.find({
            _id: { $in: savedItemIds.map((id) => new ObjectId(id)) },
            userId: req.customerId,
        }).toArray();
        if (selectedItems.length !== savedItemIds.length) {
            return res.status(404).json({ message: "No matching saved items found for your account." });
        }

        const orderItems = selectedItems.map((item) => ({
            productId: String(item.productId ?? ""),
            name: String(item.name ?? ""),
            brand: String(item.brand ?? ""),
            sku: String(item.sku ?? ""),
            thumbnail: String(item.thumbnail ?? ""),
            unitPrice: Number(item.unitPrice ?? 0),
            size: String(item.size ?? ""),
            color: String(item.color ?? ""),
            quantity: Number(item.quantity ?? 1),
        }));
        if (orderItems.some((item) => !Number.isFinite(item.unitPrice) || item.unitPrice < 0 || !Number.isInteger(item.quantity) || item.quantity < 1)) {
            return res.status(400).json({ message: "One or more selected items have invalid order details." });
        }

        const totalAmount = orderItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
        const now = new Date();
        const newOrder = {
            customerId: req.customerId,
            customerName: shippingAddress.fullName.trim(),
            customerEmail: typeof shippingAddress.email === "string" ? shippingAddress.email : "",
            items: orderItems,
            shippingAddress: {
                fullName: shippingAddress.fullName.trim(),
                phone: shippingAddress.phone.trim(),
                address: shippingAddress.address.trim(),
                city: shippingAddress.city.trim(),
                postalCode: typeof shippingAddress.postalCode === "string" ? shippingAddress.postalCode.trim() : "",
                note: typeof shippingAddress.note === "string" ? shippingAddress.note.trim() : "",
            },
            paymentMethod: paymentMethod.trim(),
            totalAmount,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        };
        const result = await customerOrders.insertOne(newOrder);
        await customerSavedItems.deleteMany({ _id: { $in: selectedItems.map((item) => item._id) }, userId: req.customerId });
        return res.status(201).json({
            message: "Order placed successfully.",
            order: { ...newOrder, _id: String(result.insertedId) },
        });
    } catch (err) {
        console.error("Failed to place order:", err);
        return res.status(500).json({ message: "Failed to place order." });
    }
});

// Product reviews are public to read; only customers with a delivered order can write one.
app.get("/api/products/:productId/reviews", async (req, res) => {
    if (!ObjectId.isValid(req.params.productId)) return res.status(400).json({ message: "A valid productId is required." });
    try {
        const reviews = await productReviews.find({ productId: req.params.productId }).sort({ updatedAt: -1 }).toArray();
        const averageRating = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : 0;
        return res.status(200).json({ reviews: reviews.map((review) => ({ ...review, _id: String(review._id) })), averageRating, reviewCount: reviews.length });
    } catch (err) {
        console.error("Failed to fetch product reviews:", err);
        return res.status(500).json({ message: "Failed to load product reviews." });
    }
});

app.post("/api/products/:productId/reviews", requireCustomerId, async (req, res) => {
    const { rating, comment } = req.body ?? {};
    if (!ObjectId.isValid(req.params.productId)) return res.status(400).json({ message: "A valid productId is required." });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: "Rating must be between 1 and 5." });
    if (typeof comment !== "string" || comment.trim().length < 3 || comment.trim().length > 1500) return res.status(400).json({ message: "Review must be between 3 and 1500 characters." });
    try {
        const purchased = await customerOrders.findOne({ $or: [{ customerId: req.customerId }, { userId: req.customerId }], status: { $in: ["delivered", "completed"] }, "items.productId": req.params.productId });
        if (!purchased) return res.status(403).json({ message: "A delivered order is required to review this product." });
        const now = new Date();
        const review = { productId: req.params.productId, customerId: req.customerId, customerName: String(purchased.customerName ?? "Customer"), rating, comment: comment.trim(), updatedAt: now };
        await productReviews.updateOne({ productId: req.params.productId, customerId: req.customerId }, { $set: review, $setOnInsert: { createdAt: now } }, { upsert: true });
        const saved = await productReviews.findOne({ productId: req.params.productId, customerId: req.customerId });
        return res.status(200).json({ review: { ...saved, _id: String(saved._id) } });
    } catch (err) {
        console.error("Failed to save product review:", err);
        return res.status(500).json({ message: "Failed to save product review." });
    }
});

// PATCH /api/orders/:orderId - Cancel an order
app.patch("/api/orders/:orderId", requireCustomerId, async (req, res) => {
    const orderId = req.params.orderId;
    const body = req.body ?? {};
    const status = typeof body.status === "string" ? body.status.trim() : "";
    if (!ObjectId.isValid(orderId)) return res.status(400).json({ message: "A valid orderId is required." });
    if (body.action === "request-return") {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (reason.length < 3 || reason.length > 300) return res.status(400).json({ message: "Please provide a reason (3–300 characters)." });
        try {
            const filter = { _id: new ObjectId(orderId), $or: [{ customerId: req.customerId }, { userId: req.customerId }], status: { $in: ["delivered", "completed"] }, returnRequest: { $exists: false } };
            const result = await customerOrders.updateOne(filter, { $set: { returnRequest: { status: "requested", reason, requestedAt: new Date(), updatedAt: new Date() }, updatedAt: new Date() } });
            if (!result.modifiedCount) return res.status(409).json({ message: "A return request is only available for delivered orders without an existing request." });
            return res.status(200).json({ message: "Return/refund request submitted." });
        } catch (err) {
            console.error("Failed to request return:", err);
            return res.status(500).json({ message: "Failed to submit return request." });
        }
    }

    if (status !== "cancelled") {
        return res.status(400).json({ message: "Only cancellation is supported." });
    }

    try {
        const order = await customerOrders.findOne({
            _id: new ObjectId(orderId),
            $or: [{ customerId: req.customerId }, { userId: req.customerId }],
        });

        if (!order) {
            return res.status(404).json({ message: "Order not found." });
        }

        const cancellableStatuses = ["pending", "processing"];
        if (!cancellableStatuses.includes(order.status)) {
            return res.status(400).json({
                message: `Orders with status "${order.status}" cannot be cancelled.`,
            });
        }

        const result = await customerOrders.updateOne(
            {
                _id: new ObjectId(orderId),
                $or: [{ customerId: req.customerId }, { userId: req.customerId }],
                status: { $in: cancellableStatuses },
            },
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
app.delete("/api/orders/:orderId", requireCustomerId, async (req, res) => {
    const orderId = req.params.orderId;

    if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ message: "A valid orderId is required." });
    }

    try {
        const result = await customerOrders.deleteOne({
            _id: new ObjectId(orderId),
            $or: [{ customerId: req.customerId }, { userId: req.customerId }],
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
