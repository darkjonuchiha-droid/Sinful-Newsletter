// ============================================================
// Sinful Newsletter Kiosk v2.0
// In-world agent for the Sinful Newsletter Hub server.
//
// The server (server/ in this repo) is the source of truth and
// the admin UI. This kiosk:
//   - lets residents Subscribe / Unsubscribe / Get Latest
//   - resolves avatar names/UUIDs for the server
//   - performs ALL item delivery (only in-world objects can)
//   - reports its inventory so the web composer can list items
//   - keeps working from LinksetData cache when the server is down
//
// SETUP: set SERVER_URL and TOKEN below (TOKEN must match
// KIOSK_TOKEN in server/.env), drop deliverable items into this
// prim. Items must be copy+transfer.
// ============================================================

// ---- Configuration -----------------------------------------
string  SERVER_URL      = "http://YOUR-SERVER:8710"; // no trailing slash
string  TOKEN           = "change-me-too";
string  NEWSLETTER_NAME = "Sinful Newsletter";
float   HEARTBEAT       = 300.0;   // seconds between hellos when idle

// ---- State -------------------------------------------------
string  g_url;          // our HTTP-in URL (empty until granted)
list    g_http;         // strided [request_id, type, aux]
list    g_queries;      // strided [dataserver_id, type, lookup_id]
list    g_dq;           // delivery queue, strided [id, uuid, pkg_json]
list    g_results;      // report queue, strided [id, status]
integer g_lastHello;    // unixtime of last successful hello
integer g_dlgChan;

// ============================================================
// Helpers
// ============================================================

string toUsername(string name)
{
    list p = llParseString2List(llToLower(llStringTrim(name, STRING_TRIM)), [" ", "."], []);
    if (llGetListLength(p) >= 2 && llList2String(p, 1) != "resident")
        return llList2String(p, 0) + "." + llList2String(p, 1);
    return llList2String(p, 0);
}

string typeName(integer t)
{
    if (t == INVENTORY_NOTECARD) return "notecard";
    if (t == INVENTORY_LANDMARK) return "landmark";
    if (t == INVENTORY_OBJECT)   return "object";
    if (t == INVENTORY_TEXTURE)  return "texture";
    if (t == INVENTORY_CLOTHING) return "clothing";
    if (t == INVENTORY_ANIMATION) return "animation";
    if (t == INVENTORY_GESTURE)  return "gesture";
    if (t == INVENTORY_SOUND)    return "sound";
    return "item";
}

// JSON array describing our inventory (excluding scripts).
string invJson()
{
    list objs = [];
    integer n = llGetInventoryNumber(INVENTORY_ALL);
    integer i;
    for (i = 0; i < n; ++i)
    {
        string nm = llGetInventoryName(INVENTORY_ALL, i);
        integer t = llGetInventoryType(nm);
        if (t != INVENTORY_SCRIPT)
        {
            integer mask = llGetInventoryPermMask(nm, MASK_OWNER);
            integer ok = 0;
            if ((mask & PERM_COPY) && (mask & PERM_TRANSFER)) ok = 1;
            objs += llList2Json(JSON_OBJECT,
                ["name", nm, "type", typeName(t), "ok", ok]);
        }
    }
    return llList2Json(JSON_ARRAY, objs);
}

// HTTP to the hub. type/aux are used to route the response.
req(string method, string path, string body, string type, string aux)
{
    key id = llHTTPRequest(SERVER_URL + "/api/kiosk" + path,
        [HTTP_METHOD, method,
         HTTP_MIMETYPE, "application/json",
         HTTP_CUSTOM_HEADER, "X-Kiosk-Token", TOKEN,
         HTTP_BODY_MAXLENGTH, 16384],
        body);
    if (id == NULL_KEY) // throttled — degrade per request type
    {
        if (type == "event") queueOutbox(aux);
        else if (type == "latest") latestFallback((key)aux);
        return;
    }
    g_http += [id, type, aux];
}

// ---- offline resilience ------------------------------------

queueOutbox(string json)
{
    integer n = (integer)llLinksetDataRead("outn") + 1;
    llLinksetDataWrite("outn", (string)n);
    llLinksetDataWrite("out:" + (string)n, json);
}

// Push one stored event; its success handler calls us again.
flushOutbox()
{
    list ks = llLinksetDataFindKeys("^out:", 0, 1);
    if (ks == []) return;
    string k = llList2String(ks, 0);
    req("POST", "/event", llLinksetDataRead(k), "eventout", k);
}

// Deliver the cached latest package when the server is unreachable.
latestFallback(key user)
{
    string pkg = llLinksetDataRead("latest");
    if (pkg == "")
    {
        llRegionSayTo(user, 0, NEWSLETTER_NAME + ": nothing available right now, sorry!");
        return;
    }
    deliverSmart(user, pkg);
}

// ---- delivery ----------------------------------------------

deliverPkg(key dest, string pkgJson)
{
    string name = llJsonGetValue(pkgJson, ["name"]);
    string msg = llJsonGetValue(pkgJson, ["msg"]);
    if (msg == JSON_INVALID) msg = "";
    list give = [];
    integer i = 0;
    while (llJsonValueType(pkgJson, ["items", i]) != JSON_INVALID)
    {
        string nm = llJsonGetValue(pkgJson, ["items", i]);
        if (llGetInventoryType(nm) != INVENTORY_NONE) give += nm;
        i++;
    }
    string text = NEWSLETTER_NAME + " — " + name;
    if (msg != "") text += "\n" + msg;
    llInstantMessage(dest, text);                       // sleeps 2 s
    if (give != []) llGiveInventoryList(dest, name, give); // sleeps 3 s
}

// Recipients NOT in this region: llGiveInventoryList is region-local and
// fails with "cannot find destination". Single-item llGiveInventory works
// grid-wide — online avatars elsewhere get offers immediately, offline
// avatars get them queued for next login (same guarantee as group notice
// attachments). No folder grouping, but it arrives.
deliverRemote(key dest, string pkgJson)
{
    string name = llJsonGetValue(pkgJson, ["name"]);
    string msg = llJsonGetValue(pkgJson, ["msg"]);
    if (msg == JSON_INVALID) msg = "";
    string text = NEWSLETTER_NAME + " — " + name;
    if (msg != "") text += "\n" + msg;
    llInstantMessage(dest, text);
    integer i = 0;
    while (llJsonValueType(pkgJson, ["items", i]) != JSON_INVALID)
    {
        string nm = llJsonGetValue(pkgJson, ["items", i]);
        if (llGetInventoryType(nm) != INVENTORY_NONE) llGiveInventory(dest, nm);
        i++;
    }
}

// Folder give when the avatar is right here, per-item give otherwise.
// llGetAgentSize returns ZERO_VECTOR for avatars not in this region.
deliverSmart(key dest, string pkgJson)
{
    if (llGetAgentSize(dest) != ZERO_VECTOR) deliverPkg(dest, pkgJson);
    else deliverRemote(dest, pkgJson);
}

// ---- subscribing -------------------------------------------

// listName "" = general subscription; otherwise also joins that list.
subscribe(key id, string name, string listName)
{
    list kv = ["type", "sub", "uuid", (string)id, "name", name];
    if (listName != "") kv += ["list", listName];
    string ev = llList2Json(JSON_OBJECT, kv);
    req("POST", "/event", ev, "event", ev);
    string extra = "";
    if (listName != "") extra = " (" + listName + " list)";
    llRegionSayTo(id, 0, "Welcome to " + NEWSLETTER_NAME + extra
        + "! You'll receive event notices and packages from now on.");
}

// ---- server conversation -----------------------------------

hello()
{
    string body = llList2Json(JSON_OBJECT, ["url", g_url, "inventory", invJson()]);
    req("POST", "/hello", body, "hello", "");
}

fetchWork()
{
    req("GET", "/work", "", "work", "");
}

reportDeliveries()
{
    if (g_results == []) return;
    list objs = [];
    integer i;
    integer n = llGetListLength(g_results);
    for (i = 0; i < n; i += 2)
        objs += llList2Json(JSON_OBJECT,
            ["id", llList2Integer(g_results, i),
             "status", llList2String(g_results, i + 1)]);
    g_results = [];
    req("POST", "/report",
        llList2Json(JSON_OBJECT, ["deliveries", llList2Json(JSON_ARRAY, objs)]),
        "report", "");
}

// After each delivery completes: report + refetch when drained, else the
// 0.5 s timer keeps draining.
finishOrContinue()
{
    if (llGetListLength(g_dq) == 0)
    {
        llSetTimerEvent(HEARTBEAT);
        reportDeliveries();
    }
}

reportLookup(integer lid, string field, string value)
{
    list kv = ["id", lid];
    if (field != "") kv += [field, value];
    req("POST", "/report",
        llList2Json(JSON_OBJECT,
            ["lookups", llList2Json(JSON_ARRAY, [llList2Json(JSON_OBJECT, kv)])]),
        "report", "");
}

processWork(string body)
{
    integer i = 0;
    while (llJsonValueType(body, ["lookups", i]) == JSON_OBJECT)
    {
        integer lid = (integer)llJsonGetValue(body, ["lookups", i, "id"]);
        string kind = llJsonGetValue(body, ["lookups", i, "kind"]);
        string q = llJsonGetValue(body, ["lookups", i, "query"]);
        if (kind == "name2key")
        {
            key d1 = llRequestUserKey(toUsername(q));
            g_queries += [d1, "n2k", (string)lid];
        }
        else
        {
            key d2 = llRequestAgentData((key)q, DATA_NAME);
            g_queries += [d2, "k2n", (string)lid];
        }
        i++;
    }
    i = 0;
    integer added = 0;
    while (llJsonValueType(body, ["deliveries", i]) == JSON_OBJECT)
    {
        g_dq += [(integer)llJsonGetValue(body, ["deliveries", i, "id"]),
                 llJsonGetValue(body, ["deliveries", i, "uuid"]),
                 llJsonGetValue(body, ["deliveries", i, "pkg"])];
        added++;
        i++;
    }
    if (added > 0) llSetTimerEvent(0.5); // start/continue the drain loop
}

requestUrl()
{
    if (g_url != "") llReleaseURL(g_url);
    g_url = "";
    llRequestURL();
}

// ============================================================
// Main state
// ============================================================

default
{
    state_entry()
    {
        g_dlgChan = -1 - (integer)llFrand(2000000000.0);
        llListen(g_dlgChan, "", NULL_KEY, "");
        llSetTimerEvent(HEARTBEAT);
        requestUrl();
        llOwnerSay(NEWSLETTER_NAME + " kiosk starting — connecting to " + SERVER_URL);
    }

    on_rez(integer p) { llResetScript(); }

    changed(integer c)
    {
        if (c & CHANGED_OWNER) llResetScript();
        if (c & (CHANGED_REGION_START | CHANGED_REGION | CHANGED_TELEPORT)) requestUrl();
        if (c & CHANGED_INVENTORY) hello(); // re-report items to the web UI
    }

    http_request(key id, string method, string body)
    {
        if (method == URL_REQUEST_GRANTED)
        {
            g_url = body;
            hello();
            return;
        }
        if (method == URL_REQUEST_DENIED)
        {
            llOwnerSay("WARNING: no HTTP-in URL available (" + body
                + "). Server pushes disabled; polling every "
                + (string)((integer)HEARTBEAT / 60) + " min instead.");
            return;
        }
        // Any POST here is a "you have work" nudge from the server.
        llHTTPResponse(id, 200, "ok");
        fetchWork();
    }

    http_response(key rid, integer status, list meta, string body)
    {
        integer idx = llListFindList(g_http, [rid]);
        if (idx == -1) return;
        string type = llList2String(g_http, idx + 1);
        string aux = llList2String(g_http, idx + 2);
        g_http = llDeleteSubList(g_http, idx, idx + 2);

        if (status != 200)
        {
            if (type == "event") queueOutbox(aux);
            else if (type == "latest") latestFallback((key)aux);
            else if (type == "hello")
                llOwnerSay("WARNING: hub unreachable (HTTP " + (string)status
                    + "). Running from cache; will retry.");
            return;
        }

        if (type == "hello")
        {
            g_lastHello = llGetUnixTime();
            if (llJsonValueType(body, ["latest"]) == JSON_OBJECT)
                llLinksetDataWrite("latest", llJsonGetValue(body, ["latest"]));
            if (llJsonValueType(body, ["listNames"]) == JSON_ARRAY)
                llLinksetDataWrite("lists", llJsonGetValue(body, ["listNames"]));
            flushOutbox();
            if ((integer)llJsonGetValue(body, ["queued"]) > 0
                || (integer)llJsonGetValue(body, ["lookups"]) > 0) fetchWork();
        }
        else if (type == "work") processWork(body);
        else if (type == "report") fetchWork(); // drain until the server is empty
        else if (type == "eventout")
        {
            llLinksetDataDelete(aux);
            flushOutbox();
        }
        else if (type == "latest")
        {
            if (llJsonValueType(body, ["latest"]) == JSON_OBJECT)
            {
                string pkg = llJsonGetValue(body, ["latest"]);
                llLinksetDataWrite("latest", pkg);
                deliverSmart((key)aux, pkg);
            }
            else llRegionSayTo((key)aux, 0,
                NEWSLETTER_NAME + ": no packages have been published yet.");
        }
    }

    dataserver(key qid, string data)
    {
        integer idx = llListFindList(g_queries, [qid]);
        if (idx == -1) return;
        string type = llList2String(g_queries, idx + 1);
        string aux = llList2String(g_queries, idx + 2);
        g_queries = llDeleteSubList(g_queries, idx, idx + 2);

        integer lid = (integer)aux;
        if (type == "n2k")
        {
            if ((key)data) reportLookup(lid, "uuid", data);
            else reportLookup(lid, "", "");
        }
        else // k2n
        {
            if (data != "") reportLookup(lid, "name", data);
            else reportLookup(lid, "", "");
        }
    }

    touch_start(integer n)
    {
        key who = llDetectedKey(0);
        if (who == llGetOwner())
        {
            string state_txt = "server: " + SERVER_URL;
            if (g_lastHello > 0)
                state_txt += "\nlast contact: " + (string)(llGetUnixTime() - g_lastHello) + "s ago";
            else state_txt += "\nlast contact: never";
            state_txt += "\nqueue: " + (string)(llGetListLength(g_dq) / 3)
                + " deliveries, outbox: "
                + (string)llGetListLength(llLinksetDataFindKeys("^out:", 0, 100));
            llDialog(who, NEWSLETTER_NAME + " kiosk\n" + state_txt,
                ["Sync", "Status", "Close"], g_dlgChan);
        }
        else
        {
            llDialog(who, NEWSLETTER_NAME + "\n\nSubscribe for event invitations "
                + "and gift packages — no group slot needed!\n\n\"Get Latest\" "
                + "re-delivers the newest package.",
                ["Subscribe", "Get Latest", "Unsubscribe"], g_dlgChan);
        }
    }

    listen(integer chan, string name, key id, string msg)
    {
        if (chan != g_dlgChan) return;

        if (id == llGetOwner())
        {
            if (msg == "Sync") { hello(); llOwnerSay("Syncing with hub..."); }
            else if (msg == "Status") llOwnerSay("URL: " + g_url
                + "\nMemory free: " + (string)llGetFreeMemory()
                + "\nLinksetData free: " + (string)llLinksetDataAvailable());
            return;
        }

        if (msg == "Subscribe")
        {
            string lj = llLinksetDataRead("lists");
            if (lj == "" || llJsonValueType(lj, [0]) == JSON_INVALID)
            {
                subscribe(id, name, ""); // no lists configured
                return;
            }
            // Offer the list choice (server caps names at 20 chars, and
            // rejects names that collide with our own buttons).
            list btns = ["Everything"];
            integer li = 0;
            while (llJsonValueType(lj, [li]) != JSON_INVALID
                && llGetListLength(btns) < 12)
            {
                btns += llJsonGetValue(lj, [li]);
                li++;
            }
            llDialog(id, NEWSLETTER_NAME
                + "\n\nWhich newsletter would you like?\n(\"Everything\" = all of them.)",
                btns, g_dlgChan);
        }
        else if (msg == "Everything")
        {
            subscribe(id, name, "");
        }
        else if (msg == "Unsubscribe")
        {
            string ev2 = llList2Json(JSON_OBJECT,
                ["type", "unsub", "uuid", (string)id, "name", name]);
            req("POST", "/event", ev2, "event", ev2);
            llRegionSayTo(id, 0, "You have been unsubscribed from "
                + NEWSLETTER_NAME + ".");
        }
        else if (msg == "Get Latest")
        {
            req("GET", "/latest?uuid=" + (string)id, "", "latest", (string)id);
        }
        else
        {
            // A button matching one of the configured list names?
            string lj3 = llLinksetDataRead("lists");
            integer lx = 0;
            while (llJsonValueType(lj3, [lx]) != JSON_INVALID)
            {
                if (llJsonGetValue(lj3, [lx]) == msg)
                {
                    subscribe(id, name, msg);
                    return;
                }
                lx++;
            }
        }
    }

    timer()
    {
        if (llGetListLength(g_dq) == 0)
        {
            // idle heartbeat
            if (g_url == "") requestUrl();
            else hello();
            return;
        }
        // drain one delivery per tick (~5 s each due to LSL sleeps)
        integer did = llList2Integer(g_dq, 0);
        key dest = (key)llList2String(g_dq, 1);
        string pkg = llList2String(g_dq, 2);
        g_dq = llDeleteSubList(g_dq, 0, 2);
        deliverSmart(dest, pkg);
        g_results += [did, "sent"];
        finishOrContinue();
    }
}
