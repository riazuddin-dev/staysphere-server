require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const app = express();

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser());
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

    const userCollection = db.collection("user");
    const propertyCollection = db.collection("properties");

    const bookingCollection = db.collection("bookings");

    const favoriteCollection = db.collection("favorites");

    const reviewCollection = db.collection("reviews");

    const transactionCollection = db.collection("transactions");

    app.get("/", (req, res) => {
      res.send("StaySphere Server Running 🚀");
    });

    // ====================== MIDDLEWARES ======================
    const verifyToken = (req, res, next) => {
      const token = req.cookies?.token;

      if (!token) {
        return res.status(401).send({ message: "Unauthorized - No token" });
      }

      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          return res.status(403).send({ message: "Invalid Token" });
        }

        req.user = decoded;
        next();
      });
    };
    const getUserRole = async (email) => {
      const user = await userCollection.findOne({ email });
      return user?.role || "tenant";
    };

    const verifyAdmin = async (req, res, next) => {
      const role = await getUserRole(req.user.email);
      if (role !== "admin") {
        return res.status(403).send({ message: "Admin Access Only" });
      }
      next();
    };

    const verifyOwner = async (req, res, next) => {
      const role = await getUserRole(req.user.email);
      if (role !== "owner") {
        return res.status(403).send({ message: "Owner Access Only" });
      }
      next();
    };

    // ====================== ROUTES ======================

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get("/jwt", (req, res) => {
      res.send("JWT Route Working");
    });

    app.post("/properties", verifyToken, verifyOwner, async (req, res) => {
      const property = req.body;
      const propertyWithOwner = {
        ...property,
        ownerEmail: req.user.email,
        status: "pending",
      };

      const result = await propertyCollection.insertOne(propertyWithOwner);
      res.send(result);
    });

    app.delete(
      "/properties/:id",
      verifyToken,
      verifyOwner,
      async (req, res) => {
        const id = req.params.id;
        const result = await propertyCollection.deleteOne({
          _id: new ObjectId(id),
          ownerEmail: req.user.email,
        });
        res.send(result);
      },
    );

    app.get("/property/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // ✅ Fixed: Check if valid ObjectId
        let query;
        if (ObjectId.isValid(id)) {
          query = { _id: new ObjectId(id) };
        } else {
          query = { _id: id }; // fallback
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

    app.patch("/property/:id", verifyToken, verifyOwner, async (req, res) => {
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
        { $set: updatedData },
      );
      res.send(result);
    });

    app.get(
      "/my-properties/:email",
      verifyToken,
      verifyOwner,
      async (req, res) => {
        const email = req.params.email;
        if (req.user.email !== email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
        const result = await propertyCollection
          .find({ ownerEmail: email })
          .toArray();
        res.send(result);
      },
    );

    app.get("/user/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.findOne({ email });
      res.send(result);
    });

    app.get("/user-role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || "tenant" });
    });

    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      if (role === "admin") {
        return res.status(403).send({ message: "Cannot assign admin role" });
      }
      const result = await userCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } },
      );
      res.send(result);
    });

    app.get("/my-bookings", verifyToken, async (req, res) => {
      const email = req.user.email;
      const result = await bookingCollection
        .find({ tenantEmail: email })
        .toArray();
      res.send(result);
    });

    app.get(
      "/booking-requests/:ownerEmail",
      verifyToken,
      verifyOwner,
      async (req, res) => {
        const ownerEmail = req.params.ownerEmail;
        if (req.user.email !== ownerEmail) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
        const result = await bookingCollection.find({ ownerEmail }).toArray();
        res.send(result);
      },
    );

    app.post("/bookings", verifyToken, async (req, res) => {
      try {
        const booking = req.body;
        if (booking.tenantEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
        if (booking.ownerEmail === req.user.email) {
          return res
            .status(403)
            .send({ message: "Cannot book your own property" });
        }
        const existing = await bookingCollection.findOne({
          propertyId: booking.propertyId,
          tenantEmail: req.user.email,
          status: { $in: ["pending", "approved"] },
        });
        if (existing) {
          return res
            .status(400)
            .send({ message: "Booking already exists for this property" });
        }
        const result = await bookingCollection.insertOne({
          ...booking,
          status: "pending",
        });
        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Booking Failed" });
      }
    });

    app.get("/properties", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 6;
        const skip = (page - 1) * limit;

        const search = req.query.search || "";
        const propertyType = req.query.propertyType || "all";
        const minPrice = parseInt(req.query.minPrice) || 0;
        const maxPrice = parseInt(req.query.maxPrice) || 999999;

        let query = { status: "approved" }; // Only approved properties for public

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

        const total = await propertyCollection.countDocuments(query);
        const properties = await propertyCollection
          .find(query)
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

    app.patch(
      "/booking-status/:id",
      verifyToken,
      verifyOwner,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { status } = req.body;
          const booking = await bookingCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!booking)
            return res.status(404).send({ message: "Booking not found" });
          if (booking.ownerEmail !== req.user.email) {
            return res.status(403).send({ message: "Forbidden" });
          }
          const result = await bookingCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } },
          );
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Status update failed" });
        }
      },
    );

    // ====================== DASHBOARD STATS ======================
    // ====================== DASHBOARD STATS ======================
    app.get("/dashboard-stats", verifyToken, async (req, res) => {
      try {
        const email = req.user?.email;
        if (!email) return res.status(401).send({ message: "Unauthorized" });

        const user = await userCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });

        const role = user.role || "tenant";

        console.log(`📊 Dashboard request from ${email} (${role})`);

        // ==================== ADMIN ====================
        if (role === "admin") {
          const totalUsers = await userCollection.countDocuments();
          const totalProperties = await propertyCollection.countDocuments();
          const totalBookings = await bookingCollection.countDocuments();

          // ✅ Fixed Revenue Calculation
          const totalRevenueResult = await transactionCollection
            .aggregate([
              {
                $group: {
                  _id: null,
                  total: { $sum: { $toDouble: "$amount" } },
                },
              },
            ])
            .toArray();

          const totalRevenue = totalRevenueResult[0]?.total || 0;

          console.log(`✅ Admin Revenue: ৳${totalRevenue}`);

          return res.send({
            role: "admin",
            totalUsers,
            totalProperties,
            totalBookings,
            totalRevenue,
          });
        }

        // ==================== OWNER ====================
        if (role === "owner") {
          const totalProperties = await propertyCollection.countDocuments({
            ownerEmail: email,
          });
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

          const totalBookings = await bookingCollection.countDocuments({
            ownerEmail: email,
          });
          const approvedBookings = await bookingCollection.countDocuments({
            ownerEmail: email,
            status: "approved",
          });
          const pendingBookings = await bookingCollection.countDocuments({
            ownerEmail: email,
            status: "pending",
          });

          // ✅ Fixed Owner Earnings
          const earningsResult = await transactionCollection
            .aggregate([
              { $match: { ownerEmail: email } },
              {
                $group: {
                  _id: null,
                  totalEarnings: { $sum: { $toDouble: "$amount" } },
                },
              },
            ])
            .toArray();

          const totalEarnings = earningsResult[0]?.totalEarnings || 0;

          console.log(`✅ Owner Earnings for ${email}: ৳${totalEarnings}`);

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
            occupancyRate:
              totalProperties > 0
                ? Math.round((approvedBookings / totalProperties) * 100)
                : 0,
          });
        }

        // ==================== TENANT ====================
        if (role === "tenant") {
          const totalBookings = await bookingCollection.countDocuments({
            tenantEmail: email,
          });
          const approvedBookings = await bookingCollection.countDocuments({
            tenantEmail: email,
            status: "approved",
          });
          const pendingBookings = await bookingCollection.countDocuments({
            tenantEmail: email,
            status: "pending",
          });

          const totalFavorites = await favoriteCollection.countDocuments({
            userEmail: email,
          });

          const transactions = await transactionCollection
            .find({ tenantEmail: email })
            .toArray();
          const totalPaid = transactions.reduce(
            (sum, t) => sum + Number(t.amount || 0),
            0,
          );

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

    app.get("/favorites", verifyToken, async (req, res) => {
      const email = req.user.email;
      const result = await favoriteCollection
        .find({ userEmail: email })
        .toArray();
      res.send(result);
    });

    app.post("/favorites", verifyToken, async (req, res) => {
      const favoriteData = { ...req.body, userEmail: req.user.email };
      const existing = await favoriteCollection.findOne({
        propertyId: favoriteData.propertyId,
        userEmail: favoriteData.userEmail,
      });
      if (existing) {
        return res.send({ message: "Already Added" });
      }
      const result = await favoriteCollection.insertOne(favoriteData);
      res.send(result);
    });

    app.delete("/favorites/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const result = await favoriteCollection.deleteOne({
        _id: new ObjectId(id),
        userEmail: req.user.email,
      });
      res.send(result);
    });

    app.post("/reviews", verifyToken, async (req, res) => {
      const review = { ...req.body, reviewerEmail: req.user.email };
      const existing = await reviewCollection.findOne({
        propertyId: review.propertyId,
        reviewerEmail: req.user.email,
      });
      if (existing) {
        return res
          .status(400)
          .send({ message: "Already reviewed this property" });
      }
      const result = await reviewCollection.insertOne(review);
      res.send(result);
    });

    app.get("/reviews/:propertyId", async (req, res) => {
      const propertyId = req.params.propertyId;
      const result = await reviewCollection.find({ propertyId }).toArray();
      res.send(result);
    });

    app.patch(
      "/property-status/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { status, feedback } = req.body;
        const result = await propertyCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, feedback } },
        );
        res.send(result);
      },
    );

    app.get("/all-properties", verifyToken, verifyAdmin, async (req, res) => {
      const result = await propertyCollection.find().toArray();
      res.send(result);
    });

    app.get("/all-bookings", verifyToken, verifyAdmin, async (req, res) => {
      const result = await bookingCollection.find().toArray();
      res.send(result);
    });

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

    app.get("/transactions", verifyToken, async (req, res) => {
      const role = await getUserRole(req.user.email);
      let query = {};
      if (role === "owner") {
        query = { ownerEmail: req.user.email };
      } else if (role === "tenant") {
        query = { tenantEmail: req.user.email };
      }
      const result = await transactionCollection.find(query).toArray();
      res.send(result);
    });

    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });
      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.send({ success: true });
    });

    app.post("/logout", (req, res) => {
      res.clearCookie("token");
      res.send({ success: true, message: "Logout Successful" });
    });

    app.get("/private", verifyToken, (req, res) => {
      res.send({ success: true, user: req.user });
    });

    app.post("/save-user", async (req, res) => {
      const user = req.body;
      const existingUser = await userCollection.findOne({ email: user.email });
      if (existingUser) {
        if (!existingUser.role) {
          await userCollection.updateOne(
            { email: user.email },
            { $set: { role: "tenant" } },
          );
        }
        return res.send({ success: true });
      }
      await userCollection.insertOne({
        ...user,
        role: "tenant",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      res.send({ success: true });
    });

    console.log("MongoDB Connected ✅");
  } catch (error) {
    console.log(error);
  }
}

run().catch(console.dir);

const port = process.env.PORT || 5000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
