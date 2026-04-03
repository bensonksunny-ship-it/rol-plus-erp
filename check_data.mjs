import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, where } from "firebase/firestore";

const app = initializeApp({
  apiKey: "AIzaSyDMMMYyamkxlz_Ot13_MQz4IDgV3dhrKMo",
  authDomain: "rol-plus-erp.firebaseapp.com",
  projectId: "rol-plus-erp",
});
const db = getFirestore(app);

// Find Benteacher
const usersSnap = await getDocs(collection(db, "users"));
const benteacher = usersSnap.docs.find(d => {
  const data = d.data();
  return (data.displayName || data.name || "").toLowerCase().includes("ben") && data.role === "teacher";
});

if (!benteacher) {
  console.log("Benteacher not found. All teachers:");
  usersSnap.docs.filter(d => d.data().role === "teacher").forEach(d => {
    console.log("  ", d.id, d.data().displayName || d.data().name, "centerIds:", JSON.stringify(d.data().centerIds));
  });
  process.exit(0);
}

console.log("=== BENTEACHER ===");
console.log("uid:", benteacher.id);
console.log("name:", benteacher.data().displayName || benteacher.data().name);
console.log("centerIds:", JSON.stringify(benteacher.data().centerIds));

const centerIds = benteacher.data().centerIds || [];

// Find demo centre
const centersSnap = await getDocs(collection(db, "centers"));
const demoCentres = centersSnap.docs.filter(d =>
  (d.data().name || "").toLowerCase().includes("demo") || centerIds.includes(d.id)
);
console.log("\n=== CENTRES ===");
demoCentres.forEach(d => {
  console.log("  id:", d.id, "name:", d.data().name, "teacherUid:", d.data().teacherUid);
});

// Find students per centreId
console.log("\n=== STUDENTS PER CENTRE ===");
for (const cid of centerIds) {
  const stuSnap = await getDocs(query(
    collection(db, "users"),
    where("role", "==", "student"),
    where("centerId", "==", cid),
  ));
  console.log(`  centreId: ${cid} → ${stuSnap.size} students`);
  stuSnap.docs.forEach(d => {
    console.log(`    uid: ${d.id}  name: ${d.data().displayName || d.data().name}  centerId: ${d.data().centerId}`);
  });
}

// All students (to spot the leak)
console.log("\n=== ALL STUDENTS ===");
const allStudents = usersSnap.docs.filter(d => d.data().role === "student");
allStudents.forEach(d => {
  console.log(`  uid: ${d.id}  name: ${d.data().displayName || d.data().name}  centerId: ${d.data().centerId}`);
});

// Attendance records for today
const today = new Date().toISOString().slice(0, 10);
console.log("\n=== ATTENDANCE TODAY (" + today + ") ===");
for (const cid of centerIds) {
  const attSnap = await getDocs(query(
    collection(db, "attendance"),
    where("centerId", "==", cid),
    where("date", "==", today),
  ));
  console.log(`  centreId: ${cid} → ${attSnap.size} records`);
  attSnap.docs.forEach(d => {
    console.log(`    studentUid: ${d.data().studentUid}  status: ${d.data().status}  date: ${d.data().date}  markedAt: ${d.data().markedAt}`);
  });
}

// Also check attendance WITHOUT date field (old class-based records)
console.log("\n=== ATTENDANCE (no date filter, by centreId) ===");
for (const cid of centerIds) {
  const attSnap = await getDocs(query(
    collection(db, "attendance"),
    where("centerId", "==", cid),
  ));
  console.log(`  centreId: ${cid} → ${attSnap.size} total records`);
  attSnap.docs.slice(0, 5).forEach(d => {
    const data = d.data();
    console.log(`    id: ${d.id}  studentUid: ${data.studentUid}  status: ${data.status}  date: ${data.date ?? "(no date)"}  classId: ${data.classId ?? "(none)"}`);
  });
}

process.exit(0);
