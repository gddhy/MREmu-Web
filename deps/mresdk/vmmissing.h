// There api that missing in MRE SDK
#pragma once 
#include "vmsys.h"

#ifdef __cplusplus
extern "C" {
#endif

// Log
void vm_app_log(char* str); 

// Res
VMINT vm_get_res_header();

// CharSet
VMWSTR vm_ucs2_string(VMSTR s);

// Audio —— MRE SDK 3.0.00.03 里只有 vm_set_volume，没有 getter
VMINT vm_get_volume(void);

#ifdef __cplusplus
}
#endif