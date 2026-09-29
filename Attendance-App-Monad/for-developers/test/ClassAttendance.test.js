const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("ClassAttendance", function () {
  async function deployFixture() {
    const [teacher, alice, bob, carol, outsider] = await ethers.getSigners();
    const cls = await ethers.deployContract("ClassAttendance", ["BSc CS - Blockchain"]);
    return { cls, teacher, alice, bob, carol, outsider };
  }

  async function withStudentsFixture() {
    const f = await deployFixture();
    await f.cls.addStudents([f.alice.address, f.bob.address], ["Alice", "Bob"]);
    return f;
  }

  describe("creating a class", function () {
    it("makes the creator the teacher and stores the class name", async function () {
      const { cls, teacher } = await loadFixture(deployFixture);
      const info = await cls.getClassInfo();
      expect(info.name).to.equal("BSc CS - Blockchain");
      expect(info.teacherAddress).to.equal(teacher.address);
      expect(info.enrolmentIsOpen).to.equal(false);
      expect(info.totalSessions).to.equal(0n);
      expect(info.openSessionId).to.equal(0n);
      expect(info.totalStudents).to.equal(0n);
    });

    it("requires a class name", async function () {
      await expect(ethers.deployContract("ClassAttendance", [""])).to.be.revertedWith("Class name is required");
    });
  });

  describe("addStudents", function () {
    it("adds many students in one transaction", async function () {
      const { cls, alice, bob, carol } = await loadFixture(deployFixture);
      await expect(cls.addStudents([alice.address, bob.address, carol.address], ["Alice", "Bob", "Carol"]))
        .to.emit(cls, "StudentRegistered")
        .withArgs(carol.address, "Carol", false);
      const all = await cls.getAllStudents();
      expect(all.map((s) => s.name)).to.deep.equal(["Alice", "Bob", "Carol"]);
      expect((await cls.getClassInfo()).totalStudents).to.equal(3n);
    });

    it("shares the MON sent with the call as gas money", async function () {
      const { cls, teacher, alice, bob } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("0.2");
      await expect(cls.addStudents([alice.address, bob.address], ["Alice", "Bob"], { value: amount })).to.changeEtherBalances(
        [teacher, alice, bob, cls],
        [-amount, amount / 2n, amount / 2n, 0n]
      );
    });

    it("refunds the remainder that cannot be split evenly", async function () {
      const { cls, teacher, alice, bob, carol } = await loadFixture(deployFixture);
      await expect(
        cls.addStudents([alice.address, bob.address, carol.address], ["A", "B", "C"], { value: 10n })
      ).to.changeEtherBalances([teacher, alice, bob, carol, cls], [-9n, 3n, 3n, 3n, 0n]);
    });

    it("validates the list", async function () {
      const { cls, teacher, alice, outsider } = await loadFixture(deployFixture);
      await expect(cls.connect(outsider).addStudents([alice.address], ["Alice"])).to.be.revertedWith(
        "Only the teacher can do this"
      );
      await expect(cls.addStudents([], [])).to.be.revertedWith("Add at least one student");
      await expect(cls.addStudents([alice.address], [])).to.be.revertedWith("Each wallet needs a name");
      await expect(cls.addStudents([ethers.ZeroAddress], ["X"])).to.be.revertedWith("Invalid wallet address");
      await expect(cls.addStudents([teacher.address], ["Me"])).to.be.revertedWith("The teacher cannot be a student");
      await expect(cls.addStudents([alice.address], [""])).to.be.revertedWith("Name is required");
      await expect(cls.addStudents([alice.address], ["x".repeat(61)])).to.be.revertedWith("Name is too long");
      await expect(cls.addStudents([alice.address, alice.address], ["A", "A"])).to.be.revertedWith(
        "Already in this class"
      );
      const many = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);
      await expect(cls.addStudents(many, many.map(() => "S"))).to.be.revertedWith("Too many students in one go");
    });
  });

  describe("sendGas", function () {
    it("shares MON between the chosen students", async function () {
      const { cls, teacher, alice, bob } = await loadFixture(withStudentsFixture);
      const amount = ethers.parseEther("0.1");
      await expect(cls.sendGas([alice.address, bob.address], { value: amount })).to.changeEtherBalances(
        [teacher, alice, bob],
        [-amount, amount / 2n, amount / 2n]
      );
    });

    it("is teacher-only and needs MON", async function () {
      const { cls, alice } = await loadFixture(withStudentsFixture);
      await expect(cls.connect(alice).sendGas([alice.address], { value: 1n })).to.be.revertedWith(
        "Only the teacher can do this"
      );
      await expect(cls.sendGas([alice.address])).to.be.revertedWith("Send some MON to share");
    });
  });

  describe("joinClass (self enrolment)", function () {
    it("works only while enrolment is open", async function () {
      const { cls, carol } = await loadFixture(withStudentsFixture);
      await expect(cls.connect(carol).joinClass("Carol")).to.be.revertedWith(
        "Enrolment is closed. Ask your teacher to add you"
      );
      await expect(cls.setEnrolment(true)).to.emit(cls, "EnrolmentChanged").withArgs(true);
      await expect(cls.connect(carol).joinClass("Carol"))
        .to.emit(cls, "StudentRegistered")
        .withArgs(carol.address, "Carol", true);
      await expect(cls.connect(carol).joinClass("Carol again")).to.be.revertedWith("Already in this class");
      await cls.setEnrolment(false);
      expect((await cls.getClassInfo()).totalStudents).to.equal(3n);
    });

    it("only the teacher toggles enrolment, and only to a new value", async function () {
      const { cls, alice } = await loadFixture(deployFixture);
      await expect(cls.connect(alice).setEnrolment(true)).to.be.revertedWith("Only the teacher can do this");
      await expect(cls.setEnrolment(false)).to.be.revertedWith("Enrolment is already closed");
      await cls.setEnrolment(true);
      await expect(cls.setEnrolment(true)).to.be.revertedWith("Enrolment is already open");
    });
  });

  describe("removeStudent", function () {
    it("removes a student and keeps the list consistent", async function () {
      const { cls, alice, bob, carol } = await loadFixture(deployFixture);
      await cls.addStudents([alice.address, bob.address, carol.address], ["Alice", "Bob", "Carol"]);
      await expect(cls.removeStudent(alice.address)).to.emit(cls, "StudentRemoved").withArgs(alice.address);

      const names = (await cls.getAllStudents()).map((s) => s.name);
      expect(names).to.have.members(["Bob", "Carol"]);
      expect((await cls.getStudent(alice.address)).registered).to.equal(false);

      await cls.startSession("Lecture 1");
      await expect(cls.connect(alice).markAttendance()).to.be.revertedWith("You are not in this class yet");
      await expect(cls.removeStudent(alice.address)).to.be.revertedWith("Not a student in this class");

      // Removing the last one in the list also works, and students can be added back.
      await cls.removeStudent(carol.address);
      await cls.addStudents([alice.address], ["Alice"]);
      expect((await cls.getAllStudents()).map((s) => s.name)).to.deep.equal(["Bob", "Alice"]);
    });

    it("is teacher-only", async function () {
      const { cls, alice, bob } = await loadFixture(withStudentsFixture);
      await expect(cls.connect(alice).removeStudent(bob.address)).to.be.revertedWith("Only the teacher can do this");
    });
  });

  describe("sessions and markAttendance", function () {
    it("records each student once per open session", async function () {
      const { cls, alice, bob } = await loadFixture(withStudentsFixture);
      await expect(cls.connect(alice).markAttendance()).to.be.revertedWith("No session is open right now");

      await expect(cls.startSession("Lecture 1")).to.emit(cls, "SessionStarted");
      await expect(cls.startSession("Lecture 2")).to.be.revertedWith("End the current session first");
      await expect(cls.connect(alice).markAttendance()).to.emit(cls, "AttendanceMarked");
      await expect(cls.connect(alice).markAttendance()).to.be.revertedWith("You are already marked present");

      expect(await cls.checkAttendance(alice.address, 1)).to.equal(true);
      expect(await cls.checkAttendance(bob.address, 1)).to.equal(false);
      expect(await cls.getSessionAttendance(1)).to.deep.equal([true, false]);

      await expect(cls.endSession()).to.emit(cls, "SessionEnded");
      await expect(cls.connect(bob).markAttendance()).to.be.revertedWith("No session is open right now");
      await expect(cls.endSession()).to.be.revertedWith("No session is open");

      const [s] = await cls.getAllSessions();
      expect(s.presentCount).to.equal(1n);
      expect(s.endTime).to.be.greaterThanOrEqual(s.startTime);
    });

    it("rejects outsiders and non-teacher session control", async function () {
      const { cls, alice, outsider } = await loadFixture(withStudentsFixture);
      await expect(cls.connect(alice).startSession("x")).to.be.revertedWith("Only the teacher can do this");
      await cls.startSession("Lecture 1");
      await expect(cls.connect(outsider).markAttendance()).to.be.revertedWith("You are not in this class yet");
      await expect(cls.connect(alice).endSession()).to.be.revertedWith("Only the teacher can do this");
      await expect(cls.startSession("")).to.be.reverted;
    });

    it("counts attendance across sessions", async function () {
      const { cls, alice, bob } = await loadFixture(withStudentsFixture);
      for (let i = 1; i <= 3; i++) {
        await cls.startSession(`Lecture ${i}`);
        await cls.connect(alice).markAttendance();
        if (i === 2) await cls.connect(bob).markAttendance();
        await cls.endSession();
      }
      expect(await cls.getAttendanceCount(alice.address)).to.equal(3n);
      expect(await cls.getAttendanceCount(bob.address)).to.equal(1n);
      expect((await cls.getClassInfo()).totalSessions).to.equal(3n);
      await expect(cls.checkAttendance(alice.address, 4)).to.be.revertedWith("Session not found");
    });

    it("lets a student who got gas money from the teacher mark attendance with it", async function () {
      const { cls } = await loadFixture(deployFixture);
      const fresh = ethers.Wallet.createRandom().connect(ethers.provider);
      await cls.addStudents([fresh.address], ["New student"], { value: ethers.parseEther("0.05") });
      await cls.startSession("Lecture 1");
      await cls.connect(fresh).markAttendance();
      expect(await cls.checkAttendance(fresh.address, 1)).to.equal(true);
    });
  });
});
