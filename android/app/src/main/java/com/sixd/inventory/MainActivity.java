// package com.sixd.inventory;

// import com.getcapacitor.BridgeActivity;

// public class MainActivity extends BridgeActivity {}

package com.sixd.inventory;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before super.onCreate()
        registerPlugin(FileSavePlugin.class);
        super.onCreate(savedInstanceState);
    }
}