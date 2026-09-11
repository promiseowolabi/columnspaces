//! The browser and these tests run the same six checks (see src/lib.rs).

use encodings as lab;

macro_rules! lab_test {
    ($name:ident, $check:expr) => {
        #[test]
        fn $name() {
            let c = $check;
            assert!(c.pass, "[{}] {} — {}", c.id, c.label, c.msg);
        }
    };
}

lab_test!(dict_roundtrip, lab::check_dict_roundtrip());
lab_test!(rle_roundtrip, lab::check_rle_roundtrip());
lab_test!(bitpack_roundtrip, lab::check_bitpack_roundtrip());
lab_test!(for_roundtrip, lab::check_for_roundtrip());
lab_test!(never_expands, lab::check_never_expands());
lab_test!(storm, lab::check_storm());
