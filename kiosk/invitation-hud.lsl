// ============================================================
// Sinful Newsletter — Invitation HUD opener v1.0
//
// This script goes INSIDE the invitation object you send to
// subscribers (an envelope, a ticket, a rose...). Recipients
// attach it as a HUD; it offers to open, and opening hands
// them everything packed inside as a folder (notecard,
// landmark, gifts) — optionally popping the world map at the
// event location.
//
// BUILD AN INVITATION:
//  1. Create a prim and make it pretty (this is what they wear).
//  2. Drop in: this script + the notecard, LM and any gifts.
//     Contents should be COPY so the invite can be opened again.
//  3. Name the object (that name becomes the folder they get).
//  4. Take it into your inventory, drop it into the kiosk prim,
//     and attach it to a package in the dashboard.
// ============================================================

// ---- Configuration -----------------------------------------
string  FOLDER_NAME  = "";   // "" = use the object's name
string  EVENT_REGION = "";   // e.g. "Sinful Isle" — if set, opening also
vector  EVENT_POS    = <128.0, 128.0, 25.0>; // shows the map at this spot
integer AUTO_DETACH  = TRUE; // detach the HUD after opening

integer g_dlgChan;
integer g_opened;

open(key who)
{
    string folder = FOLDER_NAME;
    if (folder == "") folder = llGetObjectName();

    list give = [];
    integer n = llGetInventoryNumber(INVENTORY_ALL);
    integer i;
    for (i = 0; i < n; ++i)
    {
        string nm = llGetInventoryName(INVENTORY_ALL, i);
        if (llGetInventoryType(nm) != INVENTORY_SCRIPT) give += nm;
    }
    if (give == [])
    {
        llOwnerSay("This invitation is empty — nothing to unpack.");
        return;
    }
    llGiveInventoryList(who, folder, give);
    if (EVENT_REGION != "")
        llMapDestination(EVENT_REGION, EVENT_POS, ZERO_VECTOR);
    llOwnerSay("Your invitation is open — check the \"" + folder
        + "\" folder in your inventory. See you there!");
    g_opened = TRUE;

    if (AUTO_DETACH && llGetAttached() != 0)
        llRequestPermissions(llGetOwner(), PERMISSION_ATTACH);
}

default
{
    state_entry()
    {
        g_dlgChan = -1 - (integer)llFrand(2000000000.0);
        llListen(g_dlgChan, "", NULL_KEY, "");
    }

    on_rez(integer p) { llResetScript(); }

    attach(key id)
    {
        if (id == NULL_KEY) return;
        g_opened = FALSE;
        llDialog(id, "You've received an invitation!\n\nOpen it now?",
            ["Open", "Later"], g_dlgChan);
    }

    touch_start(integer n)
    {
        key who = llDetectedKey(0);
        // Attached: only the wearer can touch it anyway. Rezzed on the
        // ground: only the owner may open it (it's a personal invite).
        if (who != llGetOwner())
        {
            llRegionSayTo(who, 0, "This invitation belongs to "
                + llGetDisplayName(llGetOwner()) + ".");
            return;
        }
        open(who);
    }

    listen(integer chan, string name, key id, string msg)
    {
        if (chan != g_dlgChan) return;
        if (id != llGetOwner()) return;
        if (msg == "Open") open(id);
        else if (msg == "Later")
            llOwnerSay("Touch the invitation whenever you're ready to open it.");
    }

    run_time_permissions(integer perm)
    {
        if ((perm & PERMISSION_ATTACH) && g_opened)
        {
            // Small pause so the folder offer arrives before the HUD vanishes.
            llSleep(2.0);
            llDetachFromAvatar();
        }
    }
}
