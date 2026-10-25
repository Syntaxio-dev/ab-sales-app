package com.agarwalbrothers.sales;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the call-history reader (see CallLogReaderPlugin): read only, asks Android for permission first
        registerPlugin(CallLogReaderPlugin.class);
        // FLAG_SECURE: no screenshots or screen recording of the app, and the recent-apps card is blank,
        // so expenses and client details cannot leak that way.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);
    }
}
