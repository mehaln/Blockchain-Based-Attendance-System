// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Class Attendance (one class per contract)
/// @notice The teacher creates the class by deploying this contract from the website.
///         Students are added by the teacher (optionally with a little MON for gas) or
///         join by themselves while enrolment is open. During an open session each
///         student marks their own attendance with one click.
contract ClassAttendance {
    struct Session {
        uint256 id;
        string topic;
        uint256 startTime;
        uint256 endTime; // 0 while the session is open
        uint256 presentCount;
    }

    struct Student {
        address wallet;
        string name;
        uint256 attendanceCount;
        bool registered;
        uint256 joinedAt;
    }

    uint256 public constant MAX_NAME_LENGTH = 60;
    uint256 public constant MAX_TOPIC_LENGTH = 100;
    uint256 public constant MAX_BATCH = 100;

    address public immutable teacher;
    string public className;
    bool public enrolmentOpen;
    uint256 public sessionCount;
    uint256 public activeSessionId; // 0 when no session is open

    mapping(uint256 => Session) private sessions;
    mapping(address => Student) private students;
    address[] private studentList;
    mapping(address => uint256) private listPosition; // index + 1, 0 = not in the list
    mapping(uint256 => mapping(address => bool)) private present;

    event ClassCreated(address indexed teacher, string className);
    event StudentRegistered(address indexed student, string name, bool selfJoined);
    event StudentRemoved(address indexed student);
    event EnrolmentChanged(bool open);
    event GasSent(address indexed student, uint256 amount);
    event SessionStarted(uint256 indexed sessionId, string topic, uint256 startTime);
    event SessionEnded(uint256 indexed sessionId, uint256 endTime, uint256 presentCount);
    event AttendanceMarked(uint256 indexed sessionId, address indexed student, uint256 timestamp);

    modifier onlyTeacher() {
        require(msg.sender == teacher, "Only the teacher can do this");
        _;
    }

    constructor(string memory _className) {
        require(bytes(_className).length > 0, "Class name is required");
        require(bytes(_className).length <= MAX_TOPIC_LENGTH, "Class name is too long");
        teacher = msg.sender;
        className = _className;
        emit ClassCreated(msg.sender, _className);
    }

    // ---------------------------------------------------------------- teacher

    /// @notice Add several students in one transaction. Any MON sent with the call is
    ///         shared equally between them so they can pay for their own clicks.
    function addStudents(address[] calldata wallets, string[] calldata names) external payable onlyTeacher {
        uint256 count = wallets.length;
        require(count > 0, "Add at least one student");
        require(count == names.length, "Each wallet needs a name");
        require(count <= MAX_BATCH, "Too many students in one go");

        for (uint256 i = 0; i < count; i++) {
            _register(wallets[i], names[i], false);
        }
        if (msg.value > 0) {
            _shareGas(wallets, msg.value);
        }
    }

    /// @notice Send MON to students for gas, shared equally.
    function sendGas(address[] calldata wallets) external payable onlyTeacher {
        require(wallets.length > 0 && wallets.length <= MAX_BATCH, "Pick 1 to 100 students");
        require(msg.value > 0, "Send some MON to share");
        _shareGas(wallets, msg.value);
    }

    function removeStudent(address wallet) external onlyTeacher {
        uint256 position = listPosition[wallet];
        require(position != 0, "Not a student in this class");

        uint256 last = studentList.length - 1;
        if (position - 1 != last) {
            address moved = studentList[last];
            studentList[position - 1] = moved;
            listPosition[moved] = position;
        }
        studentList.pop();
        listPosition[wallet] = 0;
        students[wallet].registered = false;

        emit StudentRemoved(wallet);
    }

    /// @notice While enrolment is open, students can join by themselves.
    function setEnrolment(bool open) external onlyTeacher {
        require(enrolmentOpen != open, open ? "Enrolment is already open" : "Enrolment is already closed");
        enrolmentOpen = open;
        emit EnrolmentChanged(open);
    }

    function startSession(string calldata topic) external onlyTeacher returns (uint256 sessionId) {
        require(activeSessionId == 0, "End the current session first");
        require(bytes(topic).length > 0, "Topic is required");
        require(bytes(topic).length <= MAX_TOPIC_LENGTH, "Topic is too long");

        sessionId = ++sessionCount;
        sessions[sessionId] = Session({
            id: sessionId,
            topic: topic,
            startTime: block.timestamp,
            endTime: 0,
            presentCount: 0
        });
        activeSessionId = sessionId;

        emit SessionStarted(sessionId, topic, block.timestamp);
    }

    function endSession() external onlyTeacher {
        uint256 sessionId = activeSessionId;
        require(sessionId != 0, "No session is open");

        sessions[sessionId].endTime = block.timestamp;
        activeSessionId = 0;

        emit SessionEnded(sessionId, block.timestamp, sessions[sessionId].presentCount);
    }

    // ---------------------------------------------------------------- student

    /// @notice Join the class yourself (only while the teacher has enrolment open).
    function joinClass(string calldata name) external {
        require(enrolmentOpen, "Enrolment is closed. Ask your teacher to add you");
        _register(msg.sender, name, true);
    }

    /// @notice Mark yourself present in the open session.
    function markAttendance() external {
        uint256 sessionId = activeSessionId;
        require(sessionId != 0, "No session is open right now");
        require(students[msg.sender].registered, "You are not in this class yet");
        require(!present[sessionId][msg.sender], "You are already marked present");

        present[sessionId][msg.sender] = true;
        students[msg.sender].attendanceCount += 1;
        sessions[sessionId].presentCount += 1;

        emit AttendanceMarked(sessionId, msg.sender, block.timestamp);
    }

    // ---------------------------------------------------------------- views

    function checkAttendance(address student, uint256 sessionId) external view returns (bool) {
        require(sessionId > 0 && sessionId <= sessionCount, "Session not found");
        return present[sessionId][student];
    }

    function getAttendanceCount(address student) external view returns (uint256) {
        return students[student].attendanceCount;
    }

    /// @notice Everything the page needs to refresh, in one call.
    function getClassInfo()
        external
        view
        returns (
            string memory name,
            address teacherAddress,
            bool enrolmentIsOpen,
            uint256 totalSessions,
            uint256 openSessionId,
            uint256 totalStudents
        )
    {
        return (className, teacher, enrolmentOpen, sessionCount, activeSessionId, studentList.length);
    }

    function getStudent(address wallet) external view returns (Student memory) {
        return students[wallet];
    }

    function getAllStudents() external view returns (Student[] memory all) {
        all = new Student[](studentList.length);
        for (uint256 i = 0; i < studentList.length; i++) {
            all[i] = students[studentList[i]];
        }
    }

    function getSession(uint256 sessionId) external view returns (Session memory) {
        require(sessionId > 0 && sessionId <= sessionCount, "Session not found");
        return sessions[sessionId];
    }

    function getAllSessions() external view returns (Session[] memory all) {
        all = new Session[](sessionCount);
        for (uint256 i = 0; i < sessionCount; i++) {
            all[i] = sessions[i + 1];
        }
    }

    /// @notice Present/absent flags for one session, in the same order as getAllStudents().
    function getSessionAttendance(uint256 sessionId) external view returns (bool[] memory flags) {
        require(sessionId > 0 && sessionId <= sessionCount, "Session not found");
        flags = new bool[](studentList.length);
        for (uint256 i = 0; i < studentList.length; i++) {
            flags[i] = present[sessionId][studentList[i]];
        }
    }

    // ---------------------------------------------------------------- internal

    function _register(address wallet, string calldata name, bool selfJoined) private {
        require(wallet != address(0), "Invalid wallet address");
        require(wallet != teacher, "The teacher cannot be a student");
        require(!students[wallet].registered, "Already in this class");
        require(bytes(name).length > 0, "Name is required");
        require(bytes(name).length <= MAX_NAME_LENGTH, "Name is too long");

        Student storage s = students[wallet];
        s.wallet = wallet;
        s.name = name;
        s.registered = true;
        s.joinedAt = block.timestamp;
        // attendanceCount is kept if a removed student is added back
        studentList.push(wallet);
        listPosition[wallet] = studentList.length;

        emit StudentRegistered(wallet, name, selfJoined);
    }

    /// @dev Shares `amount` equally; any remainder or failed transfer goes back to the teacher.
    function _shareGas(address[] calldata wallets, uint256 amount) private {
        uint256 share = amount / wallets.length;
        uint256 sent = 0;
        for (uint256 i = 0; i < wallets.length; i++) {
            (bool ok, ) = payable(wallets[i]).call{value: share}("");
            if (ok) {
                sent += share;
                emit GasSent(wallets[i], share);
            }
        }
        uint256 refund = amount - sent;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "Refund failed");
        }
    }
}
