package com.agarwalbrothers.sales;

import android.Manifest;
import android.content.ContentResolver;
import android.database.Cursor;
import android.os.Bundle;
import android.provider.CallLog;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Reads the phone's call history, nothing else. It only ever READS (number, type, time, length), only after the person said yes in
 * the app and Android showed its own permission dialog, and only for a window of days. What to do with the rows (keep the ones that
 * match a saved client number, drop all others) is decided in the app's web code, never here.
 */
@CapacitorPlugin(
    name = "CallLogReader",
    permissions = { @Permission(strings = { Manifest.permission.READ_CALL_LOG }, alias = "calllog") }
)
public class CallLogReaderPlugin extends Plugin {

    private static final int MAX_ROWS_LIMIT = 1000;

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("state", stateName());
        call.resolve(out);
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (getPermissionState("calllog") == com.getcapacitor.PermissionState.GRANTED) {
            status(call);
            return;
        }
        requestPermissionForAlias("calllog", call, "afterRequest");
    }

    @PermissionCallback
    private void afterRequest(PluginCall call) {
        status(call);
    }

    @PluginMethod
    public void recent(PluginCall call) {
        if (getPermissionState("calllog") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Call history is not allowed.");
            return;
        }

        long since = call.getLong("sinceMs", 0L);
        int limit = Math.max(1, Math.min(MAX_ROWS_LIMIT, call.getInt("limit", 500)));

        JSArray rows = new JSArray();
        ContentResolver resolver = getContext().getContentResolver();

        Bundle query = new Bundle();
        query.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, CallLog.Calls.DATE + " > ?");
        query.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] { String.valueOf(since) });
        query.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, CallLog.Calls.DATE + " DESC");
        query.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);

        String[] columns = { CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION };

        try (Cursor cursor = resolver.query(CallLog.Calls.CONTENT_URI, columns, query, null)) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    JSObject row = new JSObject();
                    row.put("number", cursor.getString(0));
                    row.put("type", cursor.getInt(1));
                    row.put("date", cursor.getLong(2));
                    row.put("duration", cursor.getLong(3));
                    rows.put(row);
                }
            }
        } catch (SecurityException e) {
            call.reject("Call history is not allowed.");
            return;
        }

        JSObject out = new JSObject();
        out.put("calls", rows);
        call.resolve(out);
    }

    private String stateName() {
        switch (getPermissionState("calllog")) {
            case GRANTED:
                return "granted";
            case DENIED:
                return "denied";
            default:
                return "prompt";
        }
    }
}
