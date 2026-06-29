require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cookieParser = require("cookie-parser");

const app = express();

// CORS Configuration
app.use(
  cors({
    origin: [
      "https://property-platfrom.vercel.app",
      "http://localhost:3000",
    ],
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// MongoDB Connection
const client = new MongoClient(process.env.MONGO_DB, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();
    const db = client.db("staysphere");

    // Collections
    const userCollection = db.collection("user");
    const propertyCollection = db.collection("properties");
    const bookingCollection = db.collection("bookings");
    const favoriteCollection = db.collection("favorites");
    const reviewCollection = db.collection("reviews");
    const transactionCollection = db.collection("transactions");
    
    // ✅ BETTER AUTH USES "session" (SINGULAR)
    const sessionCollection = db.collection("session");

    app.get("/", (req, res) => {
      res.send("StaySphere Server Running 🚀 (Better Auth)");
    });

    // ====================== BETTER AUTH MIDDLEWARES ======================

const verifyToken = async (req, res, next) => {
  try {
    let sessionToken = req.cookies?.["better-auth.session_token"] || req.cookies?.["__Secure-better-auth.session_token"];
    
    // Check Authorization header (Bearer <token>)
    if (!sessionToken && req.headers.authorization) {
      const parts = req.headers.authorization.split(" ");
      if (parts.length === 2 && parts[0] === "Bearer") {
        sessionToken = parts[1];
      }
    }
    
    console.log("🔑 Session Token Retrieved:", sessionToken ? `${sessionToken.substring(0, 10)}...` : "NONE");

    if (!sessionToken) {
      return res.status(401).json({ message: "No session token" });
    }

    // Token থেকে প্রথম 32 characters নাও (Better Auth এর original token)
    const actualToken = sessionToken.split('.')[0].substring(0, 32);
    
    console.log("✂️ Extracted Token:", actualToken);
    console.log("📏 Extracted Length:", actualToken.length);

    // Database এ search করো
    const session = await sessionCollection.findOne({ token: actualToken });
    
    console.log("🔍 Session found:", session ? "YES ✅" : "NO ❌");

    if (!session) {
      // Debug: সব sessions দেখাও
      const allSessions = await sessionCollection.find().limit(3).toArray();
      console.log("📋 All sessions in DB:");
      allSessions.forEach((s, i) => {
        console.log(`  ${i + 1}. Token: ${s.token} (Length: ${s.token.length})`);
      });
      
      return res.status(403).json({ 
        message: "Session not found. Please login again.",
        debug: {
          extractedToken: actualToken,
          tokenLength: actualToken?.length,
        }
      });
    }

    // User খুঁজো
    const { ObjectId } = require("mongodb");
    const user = await userCollection.findOne({ 
      _id: typeof session.userId === 'string' 
        ? new ObjectId(session.userId)
        : session.userId 
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // req.user set করো
    req.user = {
      email: user.email,
      name: user.name,
      role: user.role || "tenant",
      image: user.image,
    };

    console.log("✅ User authenticated:", req.user.email, "-", req.user.role);
    next();
  } catch (error) {
    console.error("❌ Auth verification error:", error);
    return res.status(500).json({ message: "Authentication failed", error: error.message });
  }
};

    const verifyAdmin = (req, res, next) => {
      if (req.user?.role !== "admin") {
        return res.status(403).json({ message: "Admin Access Only" });
      }
      next();
    };

    const verifyOwner = (req, res, next) => {
      if (req.user?.role !== "owner") {
        return res.status(403).json({ message: "Owner Access Only" });
      }
      next();
    };

    // ====================== PUBLIC ROUTES ======================

    // Save user (registration)
    app.post("/save-user", async (req, res) => {
      try {
        const user = req.body;
        const existingUser = await userCollection.findOne({ email: user.email });

        if (existingUser) {
          if (!existingUser.role) {
            await userCollection.updateOne(
              { email: user.email },
              { $set: { role: "tenant" } }
            );
          }
          return res.send({ success: true });
        }

        await userCollection.insertOne({
          ...user,
          role: user.role || "tenant",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        res.send({ success: true });
      } catch (error) {
        res.status(500).send({ message: "Failed to save user" });
      }
    });

    // Get user role (public - no auth required)
    app.get("/user-role/:email", async (req, res) => {
      try {
        const email = req.params.email;
        console.log("🔍 Fetching role for:", email);
        
        const user = await userCollection.findOne({ email });
        
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        
        const role = user.role || "tenant";
        console.log("✅ User role:", role);
        res.send({ role });
      } catch (error) {
        console.error("❌ Error fetching role:", error);
        res.status(500).send({ message: "Failed to fetch role" });
      }
    });

    // Get single property (public)
    app.get("/property/:id", async (req, res) => {
      try {
        const id = req.params.id;
        let query;

        if (ObjectId.isValid(id)) {
          query = { _id: new ObjectId(id) };
        } else {
          query = { _id: id };
        }

        const result = await propertyCollection.findOne(query);

        if (!result) {
          return res.status(404).send({ message: "Property not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Property fetch error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get all properties (public with filters)
    app.get("/properties", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 6;
        const skip = (page - 1) * limit;

        const search = req.query.search || "";
        const propertyType = req.query.propertyType || "all";
        const minPrice = parseInt(req.query.minPrice) || 0;
        const maxPrice = parseInt(req.query.maxPrice) || 999999;
        const sort = req.query.sort || "default";

        let query = { status: "approved" };

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { location: { $regex: search, $options: "i" } },
          ];
        }

        if (propertyType !== "all") {
          query.propertyType = propertyType;
        }

        query.rent = { $gte: minPrice, $lte: maxPrice };

        let sortOption = {};
        if (sort === "low-high") sortOption = { rent: 1 };
        else if (sort === "high-low") sortOption = { rent: -1 };
        else sortOption = { createdAt: -1 };

        const total = await propertyCollection.countDocuments(query);
        const properties = await propertyCollection
          .find(query)
          .sort(sortOption)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({
          total,
          page,
          totalPages: Math.ceil(total / limit),
          properties,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to load properties" });
      }
    });

    // Get property reviews (public)
    app.get("/reviews/:propertyId", async (req, res) => {
      try {
        const propertyId = req.params.propertyId;
        const result = await reviewCollection
          .find({ propertyId })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch reviews" });
      }
    });

    // ====================== PROTECTED ROUTES ======================

    // Dashboard stats
    app.get("/dashboard-stats", verifyToken, async (req, res) => {
      try {
        console.log("📊 Dashboard request from:", req.user.email, req.user.role);
        
        const email = req.user.email;
        const role = req.user.role;

        if (role === "admin") {
          const totalUsers = await userCollection.countDocuments();
          const totalProperties = await propertyCollection.countDocuments();
          const totalBookings = await bookingCollection.countDocuments();
          
          const totalRevenueResult = await transactionCollection
            .aggregate([
              {
                $group: {
                  _id: null,
                  total: { $sum: { $toDouble: "$amount" } }
                }
              }
            ])
            .toArray();
          
          const totalRevenue = totalRevenueResult[0]?.total || 0;

          return res.send({
            role: "admin",
            totalUsers,
            totalProperties,
            totalBookings,
            totalRevenue,
          });
        }

        if (role === "owner") {
          const totalProperties = await propertyCollection.countDocuments({ ownerEmail: email });
          const approvedProperties = await propertyCollection.countDocuments({
            ownerEmail: email,
            status: "approved",
          });
          const pendingProperties = await propertyCollection.countDocuments({
            ownerEmail: email,
            status: "pending",
          });
          const rejectedProperties = await propertyCollection.countDocuments({
            ownerEmail: email,
            status: "rejected",
          });

          const totalBookings = await bookingCollection.countDocuments({ ownerEmail: email });
          const approvedBookings = await bookingCollection.countDocuments({
            ownerEmail: email,
            status: "approved",
          });
          const pendingBookings = await bookingCollection.countDocuments({
            ownerEmail: email,
            status: "pending",
          });

          const earningsResult = await transactionCollection
            .aggregate([
              { $match: { ownerEmail: email } },
              {
                $group: {
                  _id: null,
                  totalEarnings: { $sum: { $toDouble: "$amount" } }
                }
              }
            ])
            .toArray();

          const totalEarnings = earningsResult[0]?.totalEarnings || 0;

          return res.send({
            role: "owner",
            totalProperties,
            approvedProperties,
            pendingProperties,
            rejectedProperties,
            totalBookings,
            approvedBookings,
            pendingBookings,
            totalEarnings,
            occupancyRate: totalProperties > 0 ? Math.round((approvedBookings / totalProperties) * 100) : 0,
          });
        }

        if (role === "tenant") {
          const totalBookings = await bookingCollection.countDocuments({ tenantEmail: email });
          const approvedBookings = await bookingCollection.countDocuments({
            tenantEmail: email,
            status: "approved",
          });
          const pendingBookings = await bookingCollection.countDocuments({
            tenantEmail: email,
            status: "pending",
          });

          const totalFavorites = await favoriteCollection.countDocuments({ userEmail: email });

          const transactions = await transactionCollection.find({ tenantEmail: email }).toArray();
          const totalPaid = transactions.reduce((sum, t) => sum + Number(t.amount || 0), 0);

          return res.send({
            role: "tenant",
            totalBookings,
            approvedBookings,
            pendingBookings,
            totalFavorites,
            totalPaid,
          });
        }

        return res.status(400).send({ message: "Invalid Role" });
      } catch (error) {
        console.error("❌ Dashboard Stats Error:", error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // Get all users (Admin only)
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await userCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch users" });
      }
    });

    // Update user role (Admin only)
    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { role } = req.body;

        if (role === "admin") {
          return res.status(403).send({ message: "Cannot assign admin role" });
        }

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update role" });
      }
    });

    // Add property (Owner only)
    app.post("/properties", verifyToken, verifyOwner, async (req, res) => {
      try {
        const property = req.body;
        const propertyWithOwner = {
          ...property,
          ownerEmail: req.user.email,
          ownerName: req.user.name,
          status: "pending",
          createdAt: new Date(),
        };

        const result = await propertyCollection.insertOne(propertyWithOwner);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add property" });
      }
    });

    // Update property (Owner only)
    app.patch("/property/:id", verifyToken, verifyOwner, async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;

        const property = await propertyCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!property || property.ownerEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await propertyCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { ...updatedData, updatedAt: new Date() } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update property" });
      }
    });

    // Delete property (Owner only)
    app.delete("/properties/:id", verifyToken, verifyOwner, async (req, res) => {
      try {
        const id = req.params.id;

        const property = await propertyCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!property || property.ownerEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await propertyCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete property" });
      }
    });

    // Get owner's properties
    app.get("/my-properties/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (req.user.email !== email && req.user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden Access" });
        }

        const result = await propertyCollection.find({ ownerEmail: email }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch properties" });
      }
    });

    // Get all properties (Admin only)
    app.get("/all-properties", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await propertyCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch properties" });
      }
    });

    // Update property status (Admin only)
    app.patch("/property-status/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { status, feedback } = req.body;

        const result = await propertyCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, feedback, updatedAt: new Date() } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update status" });
      }
    });

    // Get tenant's bookings
    app.get("/my-bookings", verifyToken, async (req, res) => {
      try {
        console.log("📋 Fetching bookings for:", req.user.email);
        
        const email = req.user.email;
        const bookings = await bookingCollection
          .find({ tenantEmail: email })
          .sort({ createdAt: -1 })
          .toArray();
        
        console.log("✅ Found bookings:", bookings.length);
        res.send(bookings);
      } catch (error) {
        console.error("❌ Error fetching bookings:", error);
        res.status(500).send({ message: "Failed to fetch bookings" });
      }
    });

    // Get owner's booking requests
    app.get("/booking-requests/:ownerEmail", verifyToken, async (req, res) => {
      try {
        const ownerEmail = req.params.ownerEmail;

        if (req.user.email !== ownerEmail && req.user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden Access" });
        }

        const result = await bookingCollection
          .find({ ownerEmail })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch bookings" });
      }
    });

    // Create booking
    app.post("/bookings", verifyToken, async (req, res) => {
      try {
        const booking = req.body;

        if (booking.tenantEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }

        if (booking.ownerEmail === req.user.email) {
          return res.status(403).send({ message: "Cannot book your own property" });
        }

        const existing = await bookingCollection.findOne({
          propertyId: booking.propertyId,
          tenantEmail: req.user.email,
          status: { $in: ["pending", "approved"] },
        });

        if (existing) {
          return res.status(400).send({ message: "Booking already exists for this property" });
        }

        const result = await bookingCollection.insertOne({
          ...booking,
          status: "pending",
          createdAt: new Date(),
        });
        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Booking Failed" });
      }
    });

    // Update booking status
    app.patch("/booking-status/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        const booking = await bookingCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!booking) {
          return res.status(404).send({ message: "Booking not found" });
        }

        if (booking.ownerEmail !== req.user.email && req.user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await bookingCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Status update failed" });
      }
    });

    // Get all bookings (Admin only)
    app.get("/all-bookings", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await bookingCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch bookings" });
      }
    });

    // Get user favorites
    app.get("/favorites", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const result = await favoriteCollection.find({ userEmail: email }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch favorites" });
      }
    });

    // Add to favorites
    app.post("/favorites", verifyToken, async (req, res) => {
      try {
        const favoriteData = {
          ...req.body,
          userEmail: req.user.email,
          createdAt: new Date(),
        };

        const existing = await favoriteCollection.findOne({
          propertyId: favoriteData.propertyId,
          userEmail: favoriteData.userEmail,
        });

        if (existing) {
          return res.send({ message: "Already Added" });
        }

        const result = await favoriteCollection.insertOne(favoriteData);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add favorite" });
      }
    });

    // Remove from favorites
    app.delete("/favorites/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await favoriteCollection.deleteOne({
          _id: new ObjectId(id),
          userEmail: req.user.email,
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to remove favorite" });
      }
    });

    // Add review
    app.post("/reviews", verifyToken, async (req, res) => {
      try {
        const review = {
          ...req.body,
          reviewerEmail: req.user.email,
          reviewerName: req.user.name,
          createdAt: new Date(),
        };

        const existing = await reviewCollection.findOne({
          propertyId: review.propertyId,
          reviewerEmail: req.user.email,
        });

        if (existing) {
          return res.status(400).send({ message: "Already reviewed this property" });
        }

        const result = await reviewCollection.insertOne(review);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add review" });
      }
    });

    // Create payment intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      try {
        const { amount } = req.body;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: parseInt(amount * 100),
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Payment Intent Failed" });
      }
    });

    // Save transaction
    app.post("/transactions", verifyToken, async (req, res) => {
      try {
        const transaction = {
          ...req.body,
          createdAt: new Date(),
        };

        const result = await transactionCollection.insertOne(transaction);
        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        console.error("Transaction Save Error:", error);
        res.status(500).send({ message: "Transaction save failed" });
      }
    });

    // Get transactions
    app.get("/transactions", verifyToken, async (req, res) => {
      try {
        const role = req.user.role;
        const email = req.user.email;

        let query = {};
        if (role === "owner") {
          query = { ownerEmail: email };
        } else if (role === "tenant") {
          query = { tenantEmail: email };
        }

        const result = await transactionCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch transactions" });
      }
    });

    // Logout
    app.post("/logout", (req, res) => {
      res.clearCookie("better-auth.session_token");
      res.clearCookie("better-auth.session_data");
      res.clearCookie("better_auth_session_token");
      res.send({ success: true, message: "Logout Successful" });
    });

    // Test route
    app.get("/private", verifyToken, (req, res) => {
      res.send({ success: true, user: req.user });
    });

    console.log("✅ MongoDB Connected (Better Auth Mode)");
  } catch (error) {
    console.log(error);
  }
}

run().catch(console.dir);

const port = process.env.PORT || 5000;

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port} (Better Auth)`);
});