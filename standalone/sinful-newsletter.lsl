// ============================================================
// Sinful Newsletter v1.0
// Group-style notices without a group.
//
// Storage: LinksetData on the prim — subscribers and events
// survive script resets, script updates, re-rezzing and copies
// of the object. Use "backup"/"restore" to move the list to an
// unrelated prim (see README).
//
// Owner admin:  touch for menus, or chat commands on /9
// Everyone else: touch to subscribe/unsubscribe.
// ============================================================

// ---- Configuration -----------------------------------------
integer ADMIN_CHANNEL   = 9;                   // owner chat command channel
string  NEWSLETTER_NAME = "Sinful Newsletter"; // shown in IMs and dialogs
integer PAGE            = 8;                   // entries per dialog page
string  BACKUP_NOTECARD = "backup";            // notecard name for restore
integer MAX_MSG_LEN     = 800;                 // IM-safe message cap

// ---- UI state ----------------------------------------------
integer g_dlgChan;      // private negative dialog channel
string  g_mode;         // current admin menu mode
integer g_page;         // current page in paginated menus
list    g_pageItems;    // LSD keys / inventory names on current page
string  g_selSub;       // uuid selected in subscriber manage view
string  g_curEvent;     // event currently viewed/edited

// ---- async lookups: strided [query_id, type, aux] ----------
list    g_queries;

// ---- blast (send-to-all) state -----------------------------
string  g_blastEvent;
integer g_blastIndex;
integer g_blastSent;

// ---- notecard restore state --------------------------------
key     g_ncQuery;
integer g_ncLine;
integer g_ncAdded;

// ============================================================
// Small helpers
// ============================================================

string trim(string s) { return llStringTrim(s, STRING_TRIM); }

integer isUUID(string s)
{
    if ((key)s) return TRUE;
    return FALSE;
}

// "Lelouch Resident" / "lelouch" / "First.Last" -> username for llRequestUserKey
string toUsername(string name)
{
    list p = llParseString2List(llToLower(trim(name)), [" ", "."], []);
    integer n = llGetListLength(p);
    if (n >= 2 && llList2String(p, 1) != "resident")
        return llList2String(p, 0) + "." + llList2String(p, 1);
    return llList2String(p, 0);
}

integer eventExists(string name)
{
    return llLinksetDataRead("evt:" + name) != "";
}

string subName(string uuid)
{
    string n = llLinksetDataRead("sub:" + uuid);
    if (n == "") n = "(unknown)";
    return n;
}

// Count LinksetData keys matching a regex pattern, in pages
// (never materializes the whole key list in script memory).
integer countFound(string pattern)
{
    integer total = 0;
    integer first = 0;
    integer got = 50;
    while (got == 50)
    {
        got = llGetListLength(llLinksetDataFindKeys(pattern, first, 50));
        total += got;
        first += got;
    }
    return total;
}

integer writeSub(string uuid, string name)
{
    integer r = llLinksetDataWrite("sub:" + uuid, name);
    if (r != LINKSETDATA_OK)
    {
        llOwnerSay("WARNING: could not store subscriber (code " + (string)r
            + ") — LinksetData may be full. Run 'status' to check.");
        return FALSE;
    }
    return TRUE;
}

writeEvent(string name, string msg, list items)
{
    string j = llList2Json(JSON_OBJECT,
        ["msg", msg, "items", llList2Json(JSON_ARRAY, items)]);
    integer r = llLinksetDataWrite("evt:" + name, j);
    if (r != LINKSETDATA_OK)
        llOwnerSay("WARNING: could not save event (code " + (string)r + ").");
}

string eventMsg(string name)
{
    string j = llLinksetDataRead("evt:" + name);
    if (j == "") return "";
    string m = llJsonGetValue(j, ["msg"]);
    if (m == JSON_INVALID) return "";
    return m;
}

list eventItems(string name)
{
    string j = llLinksetDataRead("evt:" + name);
    if (j == "") return [];
    string a = llJsonGetValue(j, ["items"]);
    if (a == JSON_INVALID) return [];
    return llJson2List(a);
}

// Find a subscriber uuid by legacy name (case-insensitive scan)
string findSubByName(string name)
{
    name = llToLower(trim(name));
    integer first = 0;
    integer got = 50;
    while (got == 50)
    {
        list ks = llLinksetDataFindKeys("^sub:", first, 50);
        got = llGetListLength(ks);
        integer i;
        for (i = 0; i < got; ++i)
        {
            string k = llList2String(ks, i);
            if (llToLower(llLinksetDataRead(k)) == name)
                return llGetSubString(k, 4, -1);
        }
        first += got;
    }
    return "";
}

// ============================================================
// Delivery
// ============================================================

deliver(key dest, string evtName)
{
    string msg = eventMsg(evtName);
    list items = eventItems(evtName);
    list give = [];
    integer i;
    integer n = llGetListLength(items);
    for (i = 0; i < n; ++i)
    {
        string nm = llList2String(items, i);
        if (llGetInventoryType(nm) != INVENTORY_NONE) give += nm;
    }
    string text = NEWSLETTER_NAME + " — " + evtName;
    if (msg != "") text += "\n" + msg;
    llInstantMessage(dest, text);                       // sleeps 2 s
    if (give != []) llGiveInventoryList(dest, evtName, give); // sleeps 3 s
}

startBlast(string evtName)
{
    if (g_blastEvent != "")
    {
        llOwnerSay("A send is already in progress (\"" + g_blastEvent + "\").");
        return;
    }
    integer total = countFound("^sub:");
    if (total == 0)
    {
        llOwnerSay("No subscribers to send to.");
        return;
    }
    g_blastEvent = evtName;
    g_blastIndex = 0;
    g_blastSent = 0;
    llOwnerSay("Sending \"" + evtName + "\" to " + (string)total
        + " subscribers (~" + (string)((total * 5 + 59) / 60)
        + " min). Progress every 25.");
    llSetTimerEvent(0.1);
}

sendToOne(string input, string evtName)
{
    input = trim(input);
    if (input == "") return;
    if (isUUID(input))
    {
        deliver((key)input, evtName);
        llOwnerSay("Sent \"" + evtName + "\" to " + input + ".");
        return;
    }
    string u = findSubByName(input);
    if (u != "")
    {
        deliver((key)u, evtName);
        llOwnerSay("Sent \"" + evtName + "\" to " + subName(u) + ".");
        return;
    }
    key q = llRequestUserKey(toUsername(input));
    g_queries += [q, "sendto", evtName];
    llOwnerSay("Looking up \"" + input + "\"...");
}

// ============================================================
// Subscriber management
// ============================================================

addSubscriber(string input)
{
    input = trim(input);
    if (input == "") return;
    if (isUUID(input))
    {
        if (llLinksetDataRead("sub:" + input) != "")
        {
            llOwnerSay(subName(input) + " is already subscribed.");
            return;
        }
        if (writeSub(input, "(resolving...)"))
        {
            key q = llRequestAgentData((key)input, DATA_NAME);
            g_queries += [q, "k2n", input];
            llOwnerSay("Added " + input + " — resolving name...");
        }
        return;
    }
    key q2 = llRequestUserKey(toUsername(input));
    g_queries += [q2, "add", input];
    llOwnerSay("Looking up \"" + input + "\"...");
}

removeSubscriber(string input)
{
    input = trim(input);
    string u;
    if (isUUID(input)) u = input;
    else u = findSubByName(input);
    if (u == "" || llLinksetDataRead("sub:" + u) == "")
    {
        llOwnerSay("Not a subscriber: " + input);
        return;
    }
    string nm = subName(u);
    llLinksetDataDelete("sub:" + u);
    llOwnerSay("Removed " + nm + " (" + u + ").");
}

listSubs()
{
    integer total = countFound("^sub:");
    llOwnerSay("Subscribers (" + (string)total + "):");
    string buf = "";
    integer first = 0;
    integer got = 50;
    while (got == 50)
    {
        list ks = llLinksetDataFindKeys("^sub:", first, 50);
        got = llGetListLength(ks);
        integer i;
        for (i = 0; i < got; ++i)
        {
            string k = llList2String(ks, i);
            buf += "\n" + llLinksetDataRead(k) + " — " + llGetSubString(k, 4, -1);
            if (llStringLength(buf) > 800)
            {
                llOwnerSay(buf);
                buf = "";
            }
        }
        first += got;
    }
    if (buf != "") llOwnerSay(buf);
}

backupDump()
{
    integer total = countFound("^sub:");
    llOwnerSay("Backup of " + (string)total + " subscribers. Copy the lines below "
        + "into a notecard named \"" + BACKUP_NOTECARD + "\" and keep it safe:");
    string buf = "";
    integer first = 0;
    integer got = 50;
    while (got == 50)
    {
        list ks = llLinksetDataFindKeys("^sub:", first, 50);
        got = llGetListLength(ks);
        integer i;
        for (i = 0; i < got; ++i)
        {
            string k = llList2String(ks, i);
            buf += llGetSubString(k, 4, -1) + "," + llLinksetDataRead(k) + "\n";
            if (llStringLength(buf) > 800)
            {
                llOwnerSay("\n" + buf);
                buf = "";
            }
        }
        first += got;
    }
    if (buf != "") llOwnerSay("\n" + buf);
    llOwnerSay("— end of backup —");
}

startRestore()
{
    if (llGetInventoryType(BACKUP_NOTECARD) != INVENTORY_NOTECARD)
    {
        llOwnerSay("No notecard named \"" + BACKUP_NOTECARD + "\" in this object. "
            + "Create one with 'uuid,name' lines (from a 'backup' dump) and drop it in.");
        return;
    }
    g_ncLine = 0;
    g_ncAdded = 0;
    llOwnerSay("Restoring from notecard...");
    g_ncQuery = llGetNotecardLine(BACKUP_NOTECARD, 0);
}

// ============================================================
// Dialogs (owner)
// ============================================================

dlg(string txt, list buttons)
{
    llDialog(llGetOwner(), txt, buttons, g_dlgChan);
}

showMain()
{
    g_mode = "main";
    dlg(NEWSLETTER_NAME
        + "\nSubscribers: " + (string)countFound("^sub:")
        + "\nEvents: " + (string)countFound("^evt:")
        + "\n\nChat commands on /" + (string)ADMIN_CHANNEL + " (try: help)",
        ["Subscribers", "Events", "Status", "Help"]);
}

showSubs()
{
    g_mode = "subs";
    integer total = countFound("^sub:");
    integer pages = (total + PAGE - 1) / PAGE;
    if (pages < 1) pages = 1;
    if (g_page >= pages) g_page = pages - 1;
    if (g_page < 0) g_page = 0;
    g_pageItems = llLinksetDataFindKeys("^sub:", g_page * PAGE, PAGE);
    integer n = llGetListLength(g_pageItems);
    string txt = "Subscribers (" + (string)total + ") — page "
        + (string)(g_page + 1) + "/" + (string)pages
        + "\nTap a number to manage.\n";
    list buttons = [];
    integer i;
    for (i = 0; i < n; ++i)
    {
        string nm = llLinksetDataRead(llList2String(g_pageItems, i));
        txt += "\n" + (string)(i + 1) + ". " + llGetSubString(nm, 0, 30);
        buttons += (string)(i + 1);
    }
    dlg(txt, buttons + ["<<", "+ Add", ">>", "Back"]);
}

showSubManage(string uuid)
{
    g_mode = "sub_rm";
    g_selSub = uuid;
    dlg("Subscriber:\n" + subName(uuid) + "\n" + uuid, ["Remove", "Back"]);
}

showEvents()
{
    g_mode = "events";
    integer total = countFound("^evt:");
    integer pages = (total + PAGE - 1) / PAGE;
    if (pages < 1) pages = 1;
    if (g_page >= pages) g_page = pages - 1;
    if (g_page < 0) g_page = 0;
    g_pageItems = llLinksetDataFindKeys("^evt:", g_page * PAGE, PAGE);
    integer n = llGetListLength(g_pageItems);
    string txt = "Events (" + (string)total + ") — page "
        + (string)(g_page + 1) + "/" + (string)pages
        + "\nTap a number to open.\n";
    list buttons = [];
    integer i;
    for (i = 0; i < n; ++i)
    {
        string nm = llGetSubString(llList2String(g_pageItems, i), 4, -1);
        txt += "\n" + (string)(i + 1) + ". " + llGetSubString(nm, 0, 30);
        buttons += (string)(i + 1);
    }
    dlg(txt, buttons + ["<<", "+ New", ">>", "Back"]);
}

showEventMenu(string name)
{
    g_mode = "evt_menu";
    g_curEvent = name;
    list items = eventItems(name);
    string msg = eventMsg(name);
    if (llStringLength(msg) > 180) msg = llGetSubString(msg, 0, 179) + "...";
    string txt = "Event: " + name + "\n\n" + msg
        + "\n\nAttachments (" + (string)llGetListLength(items) + "): "
        + llDumpList2String(items, ", ");
    if (llStringLength(txt) > 480) txt = llGetSubString(txt, 0, 479) + "...";
    dlg(txt, ["Send All", "Send One", "Edit Msg", "Items", "Delete", "Back"]);
}

showItemsMenu()
{
    g_mode = "items";
    list inv = [];
    integer n = llGetInventoryNumber(INVENTORY_ALL);
    integer i;
    for (i = 0; i < n; ++i)
    {
        string nm = llGetInventoryName(INVENTORY_ALL, i);
        if (llGetInventoryType(nm) != INVENTORY_SCRIPT && nm != BACKUP_NOTECARD)
            inv += nm;
    }
    integer total = llGetListLength(inv);
    integer pages = (total + PAGE - 1) / PAGE;
    if (pages < 1) pages = 1;
    if (g_page >= pages) g_page = pages - 1;
    if (g_page < 0) g_page = 0;
    g_pageItems = llList2List(inv, g_page * PAGE, g_page * PAGE + PAGE - 1);
    integer cnt = llGetListLength(g_pageItems);
    list cur = eventItems(g_curEvent);
    string txt = "Attach items to \"" + g_curEvent + "\" — tap a number to toggle."
        + "\nItems must be copy+transfer. Page "
        + (string)(g_page + 1) + "/" + (string)pages + "\n";
    list buttons = [];
    for (i = 0; i < cnt; ++i)
    {
        string nm = llList2String(g_pageItems, i);
        string mark = "[ ]";
        if (llListFindList(cur, [nm]) != -1) mark = "[X]";
        txt += "\n" + (string)(i + 1) + ". " + mark + " " + llGetSubString(nm, 0, 30);
        buttons += (string)(i + 1);
    }
    if (total == 0) txt += "\n(No items in the object inventory yet — drop "
        + "notecards, landmarks or objects into this prim first.)";
    dlg(txt, buttons + ["<<", "Done", ">>"]);
}

toggleItem(integer idx)
{
    string nm = llList2String(g_pageItems, idx);
    list cur = eventItems(g_curEvent);
    integer at = llListFindList(cur, [nm]);
    if (at != -1)
    {
        cur = llDeleteSubList(cur, at, at);
    }
    else
    {
        integer mask = llGetInventoryPermMask(nm, MASK_OWNER);
        if ((mask & PERM_COPY) && (mask & PERM_TRANSFER))
        {
            cur += nm;
        }
        else
        {
            llOwnerSay("WARNING: \"" + nm + "\" is not copy+transfer — not attached. "
                + "(A no-copy item would be given away permanently on first send.)");
        }
    }
    writeEvent(g_curEvent, eventMsg(g_curEvent), cur);
    showItemsMenu();
}

// ============================================================
// Status / help
// ============================================================

showStatus()
{
    string blast = "idle";
    if (g_blastEvent != "")
        blast = "sending \"" + g_blastEvent + "\" (" + (string)g_blastSent + " done)";
    llOwnerSay(NEWSLETTER_NAME + " status:"
        + "\n- Subscribers: " + (string)countFound("^sub:")
        + "\n- Events: " + (string)countFound("^evt:")
        + "\n- LinksetData free: " + (string)llLinksetDataAvailable() + " bytes"
        + "\n- Script memory free: " + (string)llGetFreeMemory() + " bytes"
        + "\n- Delivery: " + blast);
}

chatHelp()
{
    llOwnerSay(NEWSLETTER_NAME + " — commands on /" + (string)ADMIN_CHANNEL + ":"
        + "\n- add <uuid or legacy name>  (e.g. add Lelouch Resident)"
        + "\n- remove <uuid or legacy name>"
        + "\n- list — all subscribers"
        + "\n- send <event name> — send event to everyone"
        + "\n- sendto <uuid or name> | <event name> — send to one person"
        + "\n- backup — dump subscriber CSV to chat (save to a notecard!)"
        + "\n- restore — re-add subscribers from notecard \"" + BACKUP_NOTECARD + "\""
        + "\n- status / menu / reset"
        + "\nTouch the object for the menu UI (events are created there).");
}

// ============================================================
// Input handling
// ============================================================

handleCommand(string raw)
{
    string msg = trim(raw);
    if (msg == "") return;
    integer sp = llSubStringIndex(msg, " ");
    string cmd;
    string arg = "";
    if (sp == -1)
    {
        cmd = llToLower(msg);
    }
    else
    {
        cmd = llToLower(llGetSubString(msg, 0, sp - 1));
        arg = trim(llGetSubString(msg, sp + 1, -1));
    }

    if (cmd == "help") chatHelp();
    else if (cmd == "add") addSubscriber(arg);
    else if (cmd == "remove") removeSubscriber(arg);
    else if (cmd == "list") listSubs();
    else if (cmd == "send")
    {
        if (eventExists(arg)) startBlast(arg);
        else llOwnerSay("No event named \"" + arg + "\".");
    }
    else if (cmd == "sendto")
    {
        integer bar = llSubStringIndex(arg, "|");
        if (bar == -1)
        {
            llOwnerSay("Usage: sendto <uuid or name> | <event name>");
            return;
        }
        string dest = trim(llGetSubString(arg, 0, bar - 1));
        string evt = trim(llGetSubString(arg, bar + 1, -1));
        if (!eventExists(evt))
        {
            llOwnerSay("No event named \"" + evt + "\".");
            return;
        }
        sendToOne(dest, evt);
    }
    else if (cmd == "backup") backupDump();
    else if (cmd == "restore") startRestore();
    else if (cmd == "status") showStatus();
    else if (cmd == "menu") { g_page = 0; showMain(); }
    else if (cmd == "reset") llResetScript();
    else llOwnerSay("Unknown command — try: help");
}

handleAdminDialog(string msg)
{
    // numbered button?
    integer num = (integer)msg;
    integer isNum = ((string)num == msg && num >= 1);

    if (g_mode == "main")
    {
        if (msg == "Subscribers") { g_page = 0; showSubs(); }
        else if (msg == "Events") { g_page = 0; showEvents(); }
        else if (msg == "Status") { showStatus(); showMain(); }
        else if (msg == "Help")   { chatHelp(); showMain(); }
    }
    else if (g_mode == "subs")
    {
        if (msg == "Back") showMain();
        else if (msg == "<<") { g_page--; showSubs(); }
        else if (msg == ">>") { g_page++; showSubs(); }
        else if (msg == "+ Add")
        {
            g_mode = "sub_add";
            llTextBox(llGetOwner(),
                "Avatar UUID or legacy name to add\n(e.g. Lelouch Resident, or a UUID):",
                g_dlgChan);
        }
        else if (isNum && num <= llGetListLength(g_pageItems))
            showSubManage(llGetSubString(llList2String(g_pageItems, num - 1), 4, -1));
    }
    else if (g_mode == "sub_add")
    {
        addSubscriber(msg);
        showSubs();
    }
    else if (g_mode == "sub_rm")
    {
        if (msg == "Remove")
        {
            llOwnerSay("Removed " + subName(g_selSub) + ".");
            llLinksetDataDelete("sub:" + g_selSub);
        }
        showSubs();
    }
    else if (g_mode == "events")
    {
        if (msg == "Back") showMain();
        else if (msg == "<<") { g_page--; showEvents(); }
        else if (msg == ">>") { g_page++; showEvents(); }
        else if (msg == "+ New")
        {
            g_mode = "evt_name";
            llTextBox(llGetOwner(), "Name for the new event/notice (max 40 chars):",
                g_dlgChan);
        }
        else if (isNum && num <= llGetListLength(g_pageItems))
            showEventMenu(llGetSubString(llList2String(g_pageItems, num - 1), 4, -1));
    }
    else if (g_mode == "evt_name")
    {
        string name = trim(msg);
        if (name == "")
        {
            showEvents();
        }
        else if (llStringLength(name) > 40)
        {
            llOwnerSay("Event name too long (max 40 chars).");
            showEvents();
        }
        else if (eventExists(name))
        {
            llOwnerSay("An event named \"" + name + "\" already exists.");
            showEvents();
        }
        else
        {
            writeEvent(name, "", []);
            g_curEvent = name;
            g_mode = "evt_msg";
            llTextBox(llGetOwner(), "Message for \"" + name + "\":", g_dlgChan);
        }
    }
    else if (g_mode == "evt_msg" || g_mode == "evt_editmsg")
    {
        string m = trim(msg);
        if (llStringLength(m) > MAX_MSG_LEN)
        {
            m = llGetSubString(m, 0, MAX_MSG_LEN - 1);
            llOwnerSay("Message truncated to " + (string)MAX_MSG_LEN
                + " characters (IM limit).");
        }
        writeEvent(g_curEvent, m, eventItems(g_curEvent));
        if (g_mode == "evt_msg") { g_page = 0; showItemsMenu(); }
        else showEventMenu(g_curEvent);
    }
    else if (g_mode == "evt_menu")
    {
        if (msg == "Send All")
        {
            g_mode = "evt_sendall";
            integer total = countFound("^sub:");
            dlg("Send \"" + g_curEvent + "\" to " + (string)total
                + " subscribers now?\n(~5 seconds per subscriber.)",
                ["YES - Send", "Back"]);
        }
        else if (msg == "Send One")
        {
            g_mode = "evt_sendone";
            llTextBox(llGetOwner(),
                "UUID or legacy name to send \"" + g_curEvent + "\" to:", g_dlgChan);
        }
        else if (msg == "Edit Msg")
        {
            g_mode = "evt_editmsg";
            string cur = eventMsg(g_curEvent);
            if (llStringLength(cur) > 200) cur = llGetSubString(cur, 0, 199) + "...";
            llTextBox(llGetOwner(),
                "New message for \"" + g_curEvent + "\".\nCurrent:\n" + cur, g_dlgChan);
        }
        else if (msg == "Items")
        {
            g_page = 0;
            showItemsMenu();
        }
        else if (msg == "Delete")
        {
            g_mode = "evt_del";
            dlg("Delete event \"" + g_curEvent + "\"?\n(Attached items stay in "
                + "the object inventory.)", ["YES - Delete", "Back"]);
        }
        else if (msg == "Back")
        {
            g_page = 0;
            showEvents();
        }
    }
    else if (g_mode == "evt_sendone")
    {
        sendToOne(msg, g_curEvent);
        showEventMenu(g_curEvent);
    }
    else if (g_mode == "evt_sendall")
    {
        if (msg == "YES - Send") startBlast(g_curEvent);
        showEventMenu(g_curEvent);
    }
    else if (g_mode == "evt_del")
    {
        if (msg == "YES - Delete")
        {
            llLinksetDataDelete("evt:" + g_curEvent);
            llOwnerSay("Deleted event \"" + g_curEvent + "\".");
            g_page = 0;
            showEvents();
        }
        else showEventMenu(g_curEvent);
    }
    else if (g_mode == "items")
    {
        if (msg == "Done") showEventMenu(g_curEvent);
        else if (msg == "<<") { g_page--; showItemsMenu(); }
        else if (msg == ">>") { g_page++; showItemsMenu(); }
        else if (isNum && num <= llGetListLength(g_pageItems)) toggleItem(num - 1);
    }
}

handleUserDialog(key id, string name, string msg)
{
    if (msg == "Subscribe")
    {
        if (writeSub((string)id, name))
        {
            llRegionSayTo(id, 0, "You are now subscribed to " + NEWSLETTER_NAME
                + ". You'll receive event notices and items here — no group needed.");
            llOwnerSay(name + " subscribed (" + (string)countFound("^sub:") + " total).");
        }
    }
    else if (msg == "Unsubscribe")
    {
        llLinksetDataDelete("sub:" + (string)id);
        llRegionSayTo(id, 0, "You have been unsubscribed from " + NEWSLETTER_NAME + ".");
        llOwnerSay(name + " unsubscribed.");
    }
}

// ============================================================
// Main state
// ============================================================

default
{
    state_entry()
    {
        g_dlgChan = -1 - (integer)llFrand(2000000000.0);
        llListen(ADMIN_CHANNEL, "", llGetOwner(), "");
        llListen(g_dlgChan, "", NULL_KEY, "");
        llOwnerSay(NEWSLETTER_NAME + " ready — "
            + (string)countFound("^sub:") + " subscribers, "
            + (string)countFound("^evt:") + " events (from LinksetData). "
            + "Touch for menu or /" + (string)ADMIN_CHANNEL + " help.");
    }

    on_rez(integer p)
    {
        llResetScript(); // LinksetData survives; refreshes listens/channel
    }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
    }

    touch_start(integer n)
    {
        key who = llDetectedKey(0);
        if (who == llGetOwner())
        {
            g_page = 0;
            showMain();
        }
        else
        {
            if (llLinksetDataRead("sub:" + (string)who) != "")
                llDialog(who, NEWSLETTER_NAME + "\nYou are subscribed.",
                    ["Unsubscribe", "Cancel"], g_dlgChan);
            else
                llDialog(who, NEWSLETTER_NAME + "\nSubscribe to receive event "
                    + "notices, landmarks and gifts — no group slot needed!",
                    ["Subscribe", "Cancel"], g_dlgChan);
        }
    }

    listen(integer chan, string name, key id, string msg)
    {
        if (chan == ADMIN_CHANNEL)
        {
            if (id == llGetOwner()) handleCommand(msg);
            return;
        }
        if (chan == g_dlgChan)
        {
            if (id == llGetOwner()) handleAdminDialog(msg);
            else handleUserDialog(id, name, msg);
        }
    }

    dataserver(key qid, string data)
    {
        // ---- notecard restore stream ----
        if (qid == g_ncQuery)
        {
            if (data == EOF)
            {
                llOwnerSay("Restore complete — " + (string)g_ncAdded
                    + " subscribers added (" + (string)countFound("^sub:") + " total).");
                return;
            }
            integer c = llSubStringIndex(data, ",");
            if (c > 0)
            {
                string u = trim(llGetSubString(data, 0, c - 1));
                string nm = trim(llGetSubString(data, c + 1, -1));
                if (isUUID(u) && nm != "")
                {
                    if (llLinksetDataRead("sub:" + u) == "")
                    {
                        if (writeSub(u, nm)) g_ncAdded++;
                    }
                }
            }
            g_ncLine++;
            g_ncQuery = llGetNotecardLine(BACKUP_NOTECARD, g_ncLine);
            return;
        }

        // ---- name/key lookups ----
        integer idx = llListFindList(g_queries, [qid]);
        if (idx == -1) return;
        string type = llList2String(g_queries, idx + 1);
        string aux  = llList2String(g_queries, idx + 2);
        g_queries = llDeleteSubList(g_queries, idx, idx + 2);

        if (type == "add") // aux = typed name; data = uuid or NULL_KEY
        {
            if ((key)data)
            {
                if (llLinksetDataRead("sub:" + data) != "")
                {
                    llOwnerSay(subName(data) + " is already subscribed.");
                }
                else if (writeSub(data, aux))
                {
                    llOwnerSay("Added " + aux + " (" + data + ").");
                    key q = llRequestAgentData((key)data, DATA_NAME);
                    g_queries += [q, "k2n", data];
                }
            }
            else
            {
                llOwnerSay("No such resident: \"" + aux + "\".");
            }
        }
        else if (type == "k2n") // aux = uuid; data = legacy name
        {
            if (data != "" && llLinksetDataRead("sub:" + aux) != "")
            {
                writeSub(aux, data);
                llOwnerSay("Subscriber confirmed: " + data + " (" + aux + ").");
            }
        }
        else if (type == "sendto") // aux = event name; data = uuid or NULL_KEY
        {
            if ((key)data) sendToOne(data, aux);
            else llOwnerSay("Could not find that resident for sendto.");
        }
    }

    timer()
    {
        list ks = llLinksetDataFindKeys("^sub:", g_blastIndex, 1);
        if (ks == [])
        {
            llSetTimerEvent(0.0);
            llOwnerSay("Done — \"" + g_blastEvent + "\" sent to "
                + (string)g_blastSent + " subscribers.");
            g_blastEvent = "";
            return;
        }
        g_blastIndex++;
        deliver((key)llGetSubString(llList2String(ks, 0), 4, -1), g_blastEvent);
        g_blastSent++;
        if (g_blastSent % 25 == 0)
            llOwnerSay("... " + (string)g_blastSent + " sent");
    }
}
